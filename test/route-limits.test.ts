import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTE_LIMITS,
  resolveRouteLimits,
  limitFor,
  routeOfSession,
  liveReason,
} from '../src/route-limits.ts';

/**
 * G1: per-route child concurrency. Pure decision logic lives in
 * src/route-limits.ts so the gate in the client stays thin:
 *
 * - defaults from measurement (R3): zai/glm-5.3-flash = 5; every other route
 *   unlimited unless configured;
 * - configuration: PI_ORCH_ROUTE_LIMITS (JSON map) plus per-call overrides;
 *   the override wins (brief: "flag wins");
 * - a malformed limit map must fail loud: silently running unlimited is
 *   exactly the overload the feature exists to prevent;
 * - 0 (or "unlimited") removes the cap for that route;
 * - "live" means the child can still be generating: busy, a nonterminal run
 *   receipt, or a goal running/wrapping_up (brief; decided from the server's
 *   own list/detail/goal/evidence fields).
 */

test('defaults: zai/glm-5.3-flash is limited to 5, every other route unlimited', () => {
  assert.equal(DEFAULT_ROUTE_LIMITS['zai/glm-5.3-flash'], 5);
  const limits = resolveRouteLimits({ env: {} });
  assert.equal(limitFor('zai/glm-5.3-flash', limits), 5);
  assert.equal(limitFor('commandcode/deepseek/deepseek-v4.1-flash', limits), undefined);
  assert.equal(limitFor(undefined, limits), undefined, 'no model on record → no route limit');
});

test('PI_ORCH_ROUTE_LIMITS extends the defaults', () => {
  const limits = resolveRouteLimits({
    env: { PI_ORCH_ROUTE_LIMITS: '{"commandcode/deepseek/deepseek-v4.1-flash": 3}' },
  });
  assert.equal(limitFor('zai/glm-5.3-flash', limits), 5);
  assert.equal(limitFor('commandcode/deepseek/deepseek-v4.1-flash', limits), 3);
});

test('PI_ORCH_ROUTE_LIMITS overrides a default', () => {
  const limits = resolveRouteLimits({ env: { PI_ORCH_ROUTE_LIMITS: '{"zai/glm-5.3-flash": 2}' } });
  assert.equal(limitFor('zai/glm-5.3-flash', limits), 2);
});

test('malformed PI_ORCH_ROUTE_LIMITS fails loud (never silently unlimited)', () => {
  assert.throws(() => resolveRouteLimits({ env: { PI_ORCH_ROUTE_LIMITS: '{not json' } }), /PI_ORCH_ROUTE_LIMITS/);
  assert.throws(() => resolveRouteLimits({ env: { PI_ORCH_ROUTE_LIMITS: '{"route": "many"}' } }), /PI_ORCH_ROUTE_LIMITS/);
  assert.throws(() => resolveRouteLimits({ env: { PI_ORCH_ROUTE_LIMITS: '{"route": -1}' } }), /PI_ORCH_ROUTE_LIMITS/);
});

test('a per-call override wins over the env and the defaults', () => {
  const limits = resolveRouteLimits({
    env: { PI_ORCH_ROUTE_LIMITS: '{"zai/glm-5.3-flash": 2}' },
    overrides: { 'zai/glm-5.3-flash': 1 },
  });
  assert.equal(limitFor('zai/glm-5.3-flash', limits), 1);
});

test('0 removes the cap for a route (documented "unlimited")', () => {
  const limits = resolveRouteLimits({ env: { PI_ORCH_ROUTE_LIMITS: '{"zai/glm-5.3-flash": 0}' } });
  assert.equal(limitFor('zai/glm-5.3-flash', limits), undefined);
});

test('routeOfSession: modelSelector wins over model; empty strings are no route', () => {
  assert.equal(routeOfSession({ modelSelector: 'zai/glm-5.3-flash', model: 'other' }), 'zai/glm-5.3-flash');
  assert.equal(routeOfSession({ model: 'zai/glm-5.3-flash' }), 'zai/glm-5.3-flash');
  assert.equal(routeOfSession({ modelSelector: '', model: '' }), undefined);
  assert.equal(routeOfSession({}), undefined);
});

test('liveReason: busy wins, then goal running/wrapping_up, then a nonterminal receipt', () => {
  assert.equal(liveReason({ busy: true }), 'busy');
  assert.equal(liveReason({ busy: false, goalStatus: 'running' }), 'goal_running');
  assert.equal(liveReason({ busy: false, goalStatus: 'wrapping_up' }), 'goal_wrapping_up');
  assert.equal(liveReason({ busy: false, lastRunStatus: 'started' }), 'run_active');
  assert.equal(liveReason({ busy: false, lastRunStatus: 'accepted' }), 'run_active');
  assert.equal(liveReason({ busy: false, lastRunStatus: 'running' }), 'run_active');
});

test('liveReason: settled children are not live (finished idle does not count)', () => {
  assert.equal(liveReason({ busy: false, lastRunStatus: 'completed' }), null);
  assert.equal(liveReason({ busy: false, lastRunStatus: 'failed' }), null);
  assert.equal(liveReason({ busy: false, lastRunStatus: 'cancelled' }), null);
  assert.equal(liveReason({ busy: false, lastRunStatus: 'interrupted' }), null);
  assert.equal(liveReason({ busy: false, goalStatus: 'achieved' }), null);
  assert.equal(liveReason({ busy: false, goalStatus: 'paused' }), null, 'a paused goal is not generating');
  assert.equal(liveReason({}), null, 'a fresh child with no runs and no goal is idle');
  assert.equal(liveReason({ goalStatus: 'cleared', lastRunStatus: 'completed' }), null);
});
