// A read of QuickBooks that can be taken back.
//
// Reading is not writing, so for a long time these were plain requests: press
// the button and wait. But a search started by mistake - the wrong month, the
// wrong column of numbers - is exactly the thing somebody wants to stop at
// once and start again properly, and a request already in flight gives them
// nothing to press.
//
// So a read is a run like any other here: it goes a step at a time on the
// server, Stop takes effect at the end of the step in flight, Carry on takes
// only the steps that were left, and Clear log puts it away. A page draws all
// three from the run's own state, so they mean the same thing on whatever
// computer that person opens next.
//
// The reads themselves differ - a week of invoices, forty order numbers, a tab
// of a sheet - so each one is handed in as three small pieces:
//
//   plan(job)    optional; works out the steps, and may set job.steps
//   step(job)    does the next step; returns { done } when there is no more
//   finish(job, stopped)  turns what was gathered into what the page shows
//
// What the steps gather lives on job.state, which is the read's own to use.

import { realmOf } from './desk.js';

const runs = new Map();            // "desk#name" -> run
const MAX_EVENTS = 2000;

function keyOf(desk, name) { return desk + '#' + name; }

function push(run, type, msg) {
  run.lastId++;
  run.events.push({ id: run.lastId, type, msg, at: Date.now() });
  if (run.events.length > MAX_EVENTS) {
    run.events.splice(0, run.events.length - MAX_EVENTS);
  }
}

export function startRead(desk, name, recipe) {
  const key = keyOf(desk, name);
  const live = runs.get(key);
  if (live && live.state === 'running') {
    throw new Error('A read of yours is already going here');
  }

  const run = {
    id: Date.now(),
    name,
    realmId: realmOf(desk),
    state: 'running',
    stop: false,
    cursor: 0,                     // steps finished
    steps: recipe.steps || 0,      // 0 while it is not yet known
    counted: 0,                    // what the steps have gathered, for the line
    label: recipe.label || '',
    events: [],
    lastId: 0,
    startedAt: Date.now(),
    finishedAt: null,
    result: null
  };
  run.data = {};                   // the read's own scratch space
  run.recipe = recipe;

  runs.set(key, run);
  go(run).catch(e => {
    push(run, 'error', 'ERROR: ' + e.message);
    run.state = 'error';
    run.finishedAt = Date.now();
  });

  return run.id;
}

async function go(run) {
  const { plan, step, finish } = run.recipe;

  if (plan && !run.planned) {
    await plan(run);
    run.planned = true;
  }

  while (!run.stop) {
    const out = await step(run);
    if (!out || out.done) break;
    run.cursor++;
    if (out.count) run.counted += out.count;
    if (out.msg) push(run, out.found ? 'ok' : 'log', out.msg);
  }

  run.result = await finish(run, run.stop);

  if (run.stop) {
    push(run, 'log', 'Stopped - what was read so far is below.');
    run.state = 'stopped';
  } else {
    push(run, 'log', run.recipe.endLine ? run.recipe.endLine(run) : 'Finished.');
    run.state = 'done';
  }
  run.finishedAt = Date.now();
}

export function resumeRead(desk, name) {
  const run = runs.get(keyOf(desk, name));
  if (!run) throw new Error('There is no read to carry on');
  if (run.state === 'running') throw new Error('The read is still going');
  if (run.ended) throw new Error('That read has nothing left to do');

  run.stop = false;
  run.state = 'running';
  run.finishedAt = null;
  push(run, 'log', 'Carrying on from where it stopped.');
  go(run).catch(e => {
    push(run, 'error', 'ERROR: ' + e.message);
    run.state = 'error';
    run.finishedAt = Date.now();
  });
}

export function stopRead(desk, name) {
  const run = runs.get(keyOf(desk, name));
  if (!run) return false;
  run.stop = true;
  push(run, 'log', 'Stop requested - finishing the step in flight...');
  return true;
}

export function clearRead(desk, name) {
  const run = runs.get(keyOf(desk, name));
  if (run && run.state === 'running') return false;
  runs.delete(keyOf(desk, name));
  return true;
}

export function readSnapshot(desk, name, since) {
  const run = runs.get(keyOf(desk, name));
  if (!run) return null;

  return {
    id: run.id,
    name: run.name,
    state: run.state,
    label: run.label,
    done: run.cursor,
    total: run.steps || 0,
    counted: run.counted,
    canCarryOn: run.state === 'stopped' && !run.ended,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    events: run.events.filter(e => e.id > (Number(since) || 0)),
    lastEventId: run.lastId,
    result: run.result
  };
}
