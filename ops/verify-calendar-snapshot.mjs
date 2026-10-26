import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateNewsCalendarSnapshot} from '../src/news-calendar.js';

const [bodyFile, headerFile, expectedArgument, secondsArgument='0'] = process.argv.slice(2);
assert.ok(bodyFile && headerFile, 'Usage: node ops/verify-calendar-snapshot.mjs BODY HEADERS [TOTAL|-] [SECONDS]');
const elapsedMs=Number(secondsArgument)*1000;
assert.ok(Number.isFinite(elapsedMs) && elapsedMs>=0 && elapsedMs<=2500, 'Snapshot transfer must finish within 2.5 seconds');
const dates = [...fs.readFileSync(headerFile, 'utf8').matchAll(/^date:\s*(.+)\r?$/gmi)];
const responseDate = dates.at(-1)?.[1]?.trim();
const payload = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
const calendar = validateNewsCalendarSnapshot(payload, {responseDate,elapsedMs});
const total = calendar.buckets.reduce((sum, bucket) => sum + bucket.articleCount, 0);
assert.ok(total > 0, 'Published archive must retain its articles');
if (expectedArgument !== undefined && expectedArgument!=='-') assert.equal(total, Number(expectedArgument), 'Snapshot must match the independent article total');
console.log(JSON.stringify({total, buckets:calendar.buckets.length, sources:calendar.sourceCounts.find(source=>source.ecosystemLayer==='all').sourceCount,transferMs:elapsedMs,validAtServerDate:responseDate}));
