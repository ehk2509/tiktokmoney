const DEFAULTS = Object.freeze({
  enabled: true,
  maxWordsPerCue: 5,
  maxCharsPerCue: 34,
  maxGapSeconds: 0.65,
  fontName: 'DejaVu Sans',
  fontSize: 64,
  marginV: 335,
  maxWidthPx: 840,
  maxLines: 2,
});

export function buildSubtitles({
  voice = null,
  scenes = [],
  config = {},
} = {}) {
  const cleanConfig = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== null),
  );
  const options = { ...DEFAULTS, ...cleanConfig };

  if (!options.enabled) {
    return emptyResult('disabled', options, false);
  }

  const preciseWords = normalizeWordTimings(voice?.wordTimings || []);
  const words = preciseWords.length
    ? preciseWords
    : approximateWordTimingsFromScenes(scenes);

  if (!words.length) {
    return emptyResult('none', options, true);
  }

  const cues = groupWords(words, options);
  const events = cues.flatMap((cue) => buildHighlightEvents(cue));
  const layout = evaluateSubtitleLayout(cues, options);

  return {
    enabled: true,
    source: preciseWords.length ? 'voice-word-timings' : 'scene-estimate',
    cues,
    events,
    style: subtitleStyle(options),
    layout,
  };
}

export function evaluateSubtitleLayout(cues = [], config = {}) {
  const options = { ...DEFAULTS, ...config };
  const violations = [];

  for (const cue of cues) {
    const lines = cue.lines || layoutWords(cue.words || [], options);
    if (lines.length > options.maxLines) {
      violations.push({
        cueStart: cue.start,
        code: 'too-many-lines',
        lines: lines.length,
      });
    }

    lines.forEach((line, lineIndex) => {
      const widthPx = estimateRenderedWidth(line.map((item) => item.word).join(' '), options.fontSize);
      if (widthPx > options.maxWidthPx) {
        violations.push({
          cueStart: cue.start,
          code: 'line-overflow',
          line: lineIndex,
          widthPx: round(widthPx),
          maxWidthPx: options.maxWidthPx,
        });
      }
    });
  }

  return {
    passed: violations.length === 0,
    maxWidthPx: options.maxWidthPx,
    maxLines: options.maxLines,
    violations,
  };
}

export function estimateRenderedWidth(text, fontSize = DEFAULTS.fontSize) {
  let units = 0;
  for (const char of String(text || '')) {
    if (/\s/.test(char)) units += 0.32;
    else if (/[MW@#%&]/.test(char)) units += 0.82;
    else if (/[ilI1|.,'!:;]/.test(char)) units += 0.3;
    else if (/[A-Z0-9]/.test(char)) units += 0.62;
    else units += 0.54;
  }
  return units * Number(fontSize || DEFAULTS.fontSize);
}

export function renderAssDocument(subtitles) {
  const style = subtitles?.style || subtitleStyle(DEFAULTS);
  const events = Array.isArray(subtitles?.events) ? subtitles.events : [];
  const labels = Array.isArray(subtitles?.labels) ? subtitles.labels : [];

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    [
      'Style: Default',
      style.fontName,
      style.fontSize,
      '&H00FFFFFF',
      '&H0000FFFF',
      '&H00101010',
      '&H70000000',
      '-1',
      '0',
      '0',
      '0',
      '100',
      '100',
      '0',
      '0',
      '1',
      '5',
      '1',
      '2',
      '110',
      '110',
      style.marginV,
      '1',
    ].join(','),
    // Deterministic title cards for named on-screen subjects: boxed, top-center.
    [
      'Style: Label',
      style.fontName,
      Math.round(style.fontSize * 0.75),
      '&H00FFFFFF',
      '&H00FFFFFF',
      '&H00101010',
      '&H99000000',
      '-1',
      '0',
      '0',
      '0',
      '100',
      '100',
      '2',
      '0',
      '3',
      '18',
      '0',
      '8',
      '110',
      '110',
      '300',
      '1',
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const lines = events.map((event) => [
    'Dialogue: 0',
    formatAssTime(event.start),
    formatAssTime(event.end),
    'Default',
    '',
    '0',
    '0',
    '0',
    '',
    event.assText,
  ].join(','));
  const labelLines = labels.map((label) => [
    'Dialogue: 1',
    formatAssTime(label.start),
    formatAssTime(label.end),
    'Label',
    '',
    '0',
    '0',
    '0',
    '',
    `{\\fad(150,150)}${escapeAssText(String(label.text).toUpperCase())}`,
  ].join(','));

  return [...header, ...lines, ...labelLines, ''].join('\n');
}

export function renderSrtDocument(subtitles) {
  const cues = Array.isArray(subtitles?.cues) ? subtitles.cues : [];
  return cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
    (cue.lines || []).length
      ? cue.lines.map((line) => line.map((item) => item.word).join(' ')).join('\n')
      : cue.text,
    '',
  ].join('\n')).join('\n');
}

export function approximateWordTimingsFromScenes(scenes = []) {
  const words = [];

  for (const scene of scenes) {
    const sceneWords = tokenize(scene.narration || '');
    if (!sceneWords.length) continue;

    const start = Math.max(0, Number(scene.start) || 0);
    const duration = Math.max(0.5, Number(scene.duration) || 0.5);
    const weighted = sceneWords.map((word) => Math.max(1, word.replace(/[^\p{L}\p{N}]/gu, '').length));
    const totalWeight = weighted.reduce((sum, value) => sum + value, 0) || sceneWords.length;
    let cursor = start;

    sceneWords.forEach((word, index) => {
      const rawDuration = duration * (weighted[index] / totalWeight);
      const end = index === sceneWords.length - 1
        ? start + duration
        : cursor + rawDuration;

      words.push({
        word,
        start: round(cursor),
        end: round(Math.max(cursor + 0.05, end)),
      });
      cursor = end;
    });
  }

  return words;
}

function emptyResult(source, options, enabled) {
  return {
    enabled,
    source,
    cues: [],
    events: [],
    style: subtitleStyle(options),
    layout: {
      passed: true,
      maxWidthPx: options.maxWidthPx,
      maxLines: options.maxLines,
      violations: [],
    },
  };
}

function normalizeWordTimings(items) {
  return items
    .filter((item) => item && String(item.word || '').trim())
    .map((item) => ({
      word: String(item.word).trim(),
      start: Math.max(0, Number(item.start) || 0),
      end: Math.max(Number(item.start) || 0, Number(item.end) || Number(item.start) || 0),
      boundary: Boolean(item.boundary),
    }))
    // Keep zero-length words (Whisper emits them); highlight events enforce a minimum duration.
    .sort((a, b) => a.start - b.start);
}

function groupWords(words, options) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const lines = layoutWords(current, options);
    cues.push({
      start: current[0].start,
      end: current.at(-1).end,
      words: current,
      lines,
      text: current.map((item) => item.word).join(' '),
    });
    current = [];
  };

  for (const word of words) {
    const next = [...current, word];
    const text = next.map((item) => item.word).join(' ');
    const previous = current.at(-1);
    const gap = previous ? word.start - previous.end : 0;

    const wordLimitReached = current.length >= options.maxWordsPerCue;
    const canCompleteWeakPhrase = wordLimitReached
      && current.length < options.maxWordsPerCue + 2
      && (
        weakCueEnding(previous?.word)
        || dependentPhraseNeedsCompletion(current)
      )
      && text.length <= options.maxCharsPerCue
      && gap <= options.maxGapSeconds
      && fitsLayout(next, options);

    if (
      current.length
      && (
        (wordLimitReached && !canCompleteWeakPhrase)
        || text.length > options.maxCharsPerCue
        || gap > options.maxGapSeconds
        || sentenceBoundary(previous?.word)
        || clauseBoundary(previous?.word)
        || previous?.boundary
        || !fitsLayout(next, options)
      )
    ) {
      flush();
    }

    current.push(word);
  }

  flush();
  return cues;
}

function fitsLayout(words, options) {
  const lines = layoutWords(words, options);
  return lines.length <= options.maxLines
    && lines.every((line) => (
      estimateRenderedWidth(line.map((item) => item.word).join(' '), options.fontSize)
      <= options.maxWidthPx
    ));
}

function layoutWords(words, options) {
  const lines = [];
  let current = [];

  for (const word of words) {
    const next = [...current, word];
    const nextText = next.map((item) => item.word).join(' ');
    if (
      current.length
      && estimateRenderedWidth(nextText, options.fontSize) > options.maxWidthPx
    ) {
      lines.push(current);
      current = [word];
    } else {
      current = next;
    }
  }

  if (current.length) lines.push(current);
  return lines;
}

function buildHighlightEvents(cue) {
  return cue.words.map((activeWord, activeIndex) => ({
    start: activeWord.start,
    end: Math.max(activeWord.end, activeWord.start + 0.05),
    cueStart: cue.start,
    cueEnd: cue.end,
    activeWordIndex: activeIndex,
    text: cue.text,
    assText: buildAssCue(cue, activeIndex),
  }));
}

function buildAssCue(cue, activeIndex) {
  let wordIndex = 0;
  return (cue.lines || [cue.words])
    .map((line) => line.map((item) => {
      const text = escapeAssText(item.word);
      const rendered = wordIndex === activeIndex
        ? `{\\c&H0000FFFF&\\b1}${text}{\\c&H00FFFFFF&\\b1}`
        : text;
      wordIndex += 1;
      return rendered;
    }).join(' '))
    .join('\\N');
}

function subtitleStyle(options) {
  return {
    fontName: String(options.fontName || DEFAULTS.fontName),
    fontSize: clampInt(options.fontSize, 42, 96, DEFAULTS.fontSize),
    marginV: clampInt(options.marginV, 200, 560, DEFAULTS.marginV),
    maxWidthPx: clampInt(options.maxWidthPx, 620, 900, DEFAULTS.maxWidthPx),
    maxLines: clampInt(options.maxLines, 1, 2, DEFAULTS.maxLines),
  };
}

function tokenize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function sentenceBoundary(word = '') {
  return /[.!?…]["')\]]?$/.test(word);
}

function clauseBoundary(word = '') {
  return /[,;:]["')\]]?$/.test(word);
}

const WEAK_CUE_ENDINGS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on',
  'or', 'than', 'that', 'the', 'to', 'under', 'over', 'when', 'while', 'with',
]);

function weakCueEnding(word = '') {
  const token = normalizeToken(word);
  return WEAK_CUE_ENDINGS.has(token);
}

const DEPENDENT_CLAUSE_MARKERS = new Set([
  'after', 'although', 'as', 'because', 'before', 'if', 'once', 'since',
  'though', 'unless', 'until', 'when', 'whenever', 'whereas', 'while',
]);

function dependentPhraseNeedsCompletion(words = []) {
  const tokens = words.map((item) => normalizeToken(item.word)).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (!DEPENDENT_CLAUSE_MARKERS.has(tokens[index])) continue;
    const trailing = tokens.length - index - 1;
    return trailing > 0 && trailing <= 2;
  }
  return false;
}

/**
 * Transcription word timings usually lack punctuation, which the cue grouping
 * needs to avoid cues like "connected The". Copy trailing punctuation from the
 * verified script text onto the matching timed words.
 */
export function punctuateWordsFromScript(words = [], scriptText = '') {
  const tokens = String(scriptText || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .split(/\s+/)
    .filter((token) => normalizeToken(token));
  let cursor = 0;

  return words.map((item) => {
    const key = normalizeToken(item.word);
    for (let index = cursor; key && index < Math.min(tokens.length, cursor + 4); index += 1) {
      if (normalizeToken(tokens[index]) !== key) continue;
      cursor = index + 1;
      const punctuation = tokens[index].match(/[.,!?;:…]+["')\]]*$/)?.[0] || '';
      const bare = String(item.word).replace(/[.,!?;:…]+["')\]]*$/, '');
      return { ...item, word: bare + punctuation };
    }
    return item;
  });
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function escapeAssText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('\n', ' ');
}

function formatAssTime(value) {
  const totalCentiseconds = Math.max(0, Math.round((Number(value) || 0) * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function formatSrtTime(value) {
  const totalMilliseconds = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
