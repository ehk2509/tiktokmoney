import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignWordsToSpeech, collectVoiceTrackWordTimings, speechIntervalsFromSilenceLog,
} from '../src/core/speechAlignment.js';

test('speech intervals are the gaps between detected silences', () => {
  const log = 'silence_start: 0\nsilence_end: 0.2 | d\nsilence_start: 1.9\nsilence_end: 6 | d\n';
  assert.deepEqual(speechIntervalsFromSilenceLog(log, 6), [{ start: 0.2, end: 1.9 }]);
  assert.deepEqual(speechIntervalsFromSilenceLog('silence_start: 2\n', 6), [{ start: 0, end: 2 }]);
});

test('words stay inside the speech, not spread across trailing silence', () => {
  const words = alignWordsToSpeech('Have you ever wondered why cats purr?', [{ start: 0.2, end: 1.9 }], { offset: 10, clipEnd: 6 });
  assert.equal(words[0].start, 10.2);
  assert.equal(words.at(-1).word, 'purr?');
  assert.ok(words.at(-1).start < 11.9);
  assert.equal(words.at(-1).end, 12.2); // short hold so the last words stay readable
  assert.equal(words.at(-1).boundary, true);
  words.slice(1).forEach((word, i) => assert.ok(word.start >= words[i].start));
});

test('a pause in the speech is not covered by any word', () => {
  const words = alignWordsToSpeech('First part here. Second part here.', [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
  assert.equal(words[3].start, 3);
  assert.ok(words[2].end <= 1);
  assert.ok(words.every((word) => word.start < 1 || word.start >= 3));
});

test('a pause inside a phrase keeps the caption on screen, but a sentence break does not', () => {
  const phrase = alignWordsToSpeech('Ever wondered why dogs', [{ start: 0, end: 0.6 }, { start: 1.05, end: 2.4 }]);
  phrase.slice(0, -1).forEach((word, i) => assert.equal(word.end, phrase[i + 1].start));
  const sentence = alignWordsToSpeech('Absolutely wonderful. Go', [{ start: 0, end: 1.4 }, { start: 1.85, end: 2.2 }]);
  assert.ok(sentence[1].end < sentence[2].start);
});

test('only cast-voice clips are aligned; other scenes keep their estimate', async () => {
  const cast = { index: 0, start: 0, duration: 4, narration: 'Hello there', asset: { audioMode: 'local-tts-cast-voice', dialogueTrack: { localPath: 'v.wav' } } };
  const other = { index: 1, start: 4, duration: 2, narration: 'Other words', asset: { audioMode: 'native' } };
  const measured = [];
  const timings = await collectVoiceTrackWordTimings([cast, other], async (file) => { measured.push(file); return [{ start: 0.5, end: 1 }]; });
  assert.deepEqual(measured, ['v.wav']);
  assert.equal(timings[0].start, 0.5);
  assert.equal(timings[2].start, 4);
  assert.deepEqual(await collectVoiceTrackWordTimings([other]), []);
});

test('a failed measurement falls back to the estimate', async () => {
  const cast = { start: 0, duration: 4, narration: 'Hello', asset: { audioMode: 'local-tts-cast-voice', dialogueTrack: { localPath: 'v.wav' } } };
  assert.deepEqual(await collectVoiceTrackWordTimings([cast], async () => { throw new Error('no ffmpeg'); }), []);
});
