// Site configuration. APPS_SCRIPT_URL is the /exec URL of the deployed web app (README, "Backend").
// The token is not a secret: it ships with the page and only filters stray traffic.
const CONFIG = {
  APPS_SCRIPT_URL: '',
  TOKEN: '839ACyrkjLPgbOYVXbcVQnQrf8ZUizUp',
  CONTACT: 'xoy@andrew.cmu.edu',
  REPLAY_LIMIT: 3,          // plays allowed per clip (reference and stimulus counted separately)
  BATCH_SIZE: 10,           // ratings per background submission
  STORAGE_KEY: 'mos_test_state_v1',
  // Order of blocks. The second E-MOS block uses a different Latin-square group than the first,
  // so the listener hears every target again but from different systems.
  BLOCKS: [
    {test: 'emos', checks: [0, 1]},
    {test: 'nmos', checks: [0, 1, 2, 3]},
    {test: 'emos', checks: [2, 3]},
  ],
  TESTS: {
    emos: {
      name: 'Emotion similarity',
      groups: 5,
      data: 'data/emos_trials.json',
      question: 'How similar is the emotion of the second clip to the emotion of the reference?',
      instructions: [
        'Each trial has two clips. Play the <b>reference</b> first, then the <b>second clip</b>.',
        'Rate how similar the <b>emotion</b> of the second clip is to the emotion of the reference.',
        'Ignore voice identity (the speakers may differ) and ignore audio quality. Judge only the emotion.',
        'Each clip can be played at most 3 times. The rating buttons unlock after both clips have played once.',
      ],
      scale: ['Completely different', 'Mostly different', 'Somewhat similar', 'Mostly similar',
        'Identical emotion'],
    },
    nmos: {
      name: 'Naturalness',
      groups: 7,
      data: 'data/nmos_trials.json',
      question: 'How natural does this speech sound?',
      instructions: [
        'Each trial has one clip of English speech.',
        'Rate how <b>natural</b> it sounds, that is, how close it is to a real person speaking.',
        'Consider the voice, the rhythm and the audio as a whole. The content of the sentence does not matter.',
        'Each clip can be played at most 3 times. The rating buttons unlock after the clip has played once.',
      ],
      scale: ['Bad', 'Poor', 'Fair', 'Good', 'Excellent'],
    },
  },
};
