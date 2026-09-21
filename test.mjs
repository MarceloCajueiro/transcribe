#!/usr/bin/env node
// Self-check for the only non-trivial pure logic here: timestamp offsetting.
//   node test.mjs
import assert from 'node:assert/strict';
import { offsetTimestamps, formatTime } from './skills/transcribe/lib/text.mjs';

assert.equal(formatTime(0), '00:00');
assert.equal(formatTime(65), '01:05');
assert.equal(formatTime(3725), '1:02:05');

assert.equal(offsetTimestamps('[00:10] oi', 0), '[00:10] oi');
assert.equal(offsetTimestamps('[00:10] oi', 600), '[10:10] oi');
assert.equal(offsetTimestamps('[09:59] a\n[10:00] b', 600), '[19:59] a\n[20:00] b');
// crosses the hour boundary -> hh:mm:ss
assert.equal(offsetTimestamps('[05:00] x', 3600), '[1:05:00] x');
// already hh:mm:ss input
assert.equal(offsetTimestamps('[1:00:00] x', 60), '[1:01:00] x');
// a chunk's own clock can pass 99 minutes
assert.equal(offsetTimestamps('[105:30] x', 60), '[1:46:30] x');
// non-timestamp brackets are left alone
assert.equal(offsetTimestamps('[inaudible] x', 600), '[inaudible] x');

console.log('ok');
