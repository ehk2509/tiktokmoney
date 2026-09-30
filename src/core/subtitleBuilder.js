const DEFAULTS = Object.freeze({
  enabled: true,
  maxWordsPerCue: 5,
  maxCharsPerCue: 34,
  maxGapSeconds: 0.65,
  fontName: 'DejaVu Sans',
  fontSize: 68,
  marginV: 285,
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
    return {
      enabled: false,
      source: 'disabled',
      cues: [],
      events: [],
      style: subtitleStyle(options),
    };
  }

  const preciseWords = normalizeWordTimings(voice?.wordTimings || []);
  const words = preciseWords.length
    ? preciseWords
    : approximateWordTimingsFromScenes(scenes);

  if (!words.length) {
    return {
      enabled: true,
      source: 'none',
      cues: [],
      events: [],
      style: subtitleStyle(options),
    };
  }

  const cues = groupWords(words, options);
  const events = cues.flatMap((cue) => buildHighlightEvents(cue));

  return {
    enabled: true,
    source: preciseWords.length ? 'voice-word-timings' : 'scene-estimate',
    cues,
    events,
    style: subtitleStyle(options),
  };
}

export function renderAssDocument(subtitles) {
  const style = subtitles?.style || subtitleStyle(DEFAULTS);
  const events = Array.isArray(subtitles?.events) ? subtitles.events : [];

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
      '90',
      '90',
      style.marginV,
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

  return [...header, ...lines, ''].join('\n');
}

export function renderSrtDocument(subtitles) {
  const cues = Array.isArray(subtitles?.cues) ? subtitles.cues : [];
  return cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
    cue.text,
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

function normalizeWordTimings(items) {
  return items
    .filter((item) => item && String(item.word || '').trim())
    .map((item) => ({
      word: String(item.word).trim(),
      start: Math.max(0, Number(item.start) || 0),
      end: Math.max(Number(item.start) || 0, Number(item.end) || Number(item.start) || 0),
    }))
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
}

function groupWords(words, options) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0].start,
      end: current.at(-1).end,
      words: current,
      text: current.map((item) => item.word).join(' '),
    });
    current = [];
  };

  for (const word of words) {
    const next = [...current, word];
    const text = next.map((item) => item.word).join(' ');
    const previous = current.at(-1);
    const gap = previous ? word.start - previous.end : 0;

    if (
      current.length
      && (
        current.length >= options.maxWordsPerCue
        || text.length > options.maxCharsPerCue
        || gap > options.maxGapSeconds
        || sentenceBoundary(previous?.word)
      )
    ) {
      flush();
    }

    current.push(word);
  }

  flush();
  return cues;
}

function buildHighlightEvents(cue) {
  return cue.words.map((activeWord, activeIndex) => ({
    start: activeWord.start,
    end: Math.max(activeWord.end, activeWord.start + 0.05),
    cueStart: cue.start,
    cueEnd: cue.end,
    activeWordIndex: activeIndex,
    text: cue.text,
    assText: cue.words
      .map((item, index) => {
        const text = escapeAssText(item.word);
        return index === activeIndex
          ? `{\\c&H0000FFFF&\\b1}${text}{\\c&H00FFFFFF&\\b1}`
          : text;
      })
      .join(' '),
  }));
}

function subtitleStyle(options) {
  return {
    fontName: String(options.fontName || DEFAULTS.fontName),
    fontSize: clampInt(options.fontSize, 42, 96, DEFAULTS.fontSize),
    marginV: clampInt(options.marginV, 160, 520, DEFAULTS.marginV),
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
