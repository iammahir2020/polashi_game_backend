// Game data: characters, decoy names for secret intel, and mission sizes.
// Moved verbatim from server.js; the rules live here and nowhere else.

const CharacterList = [
  {
    id: 1,
    name: "মীর জাফর",
    description: "চতুর ও ধূর্ত কৌশলবিদ, বিশ্বাসঘাতকতার জন্য কুখ্যাত।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 2,
    name: "রায় দুর্লভ",
    description: "ধনী বণিক, ষড়যন্ত্র ও প্রভাব বিস্তারে পারদর্শী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 3,
    name: "ঘসেটি বেগম",
    description: "ক্ষমতালোভী ও প্রভাবশালী, নীরবে ইস্ট ইন্ডিয়া কোম্পানিকে সমর্থনকারী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 4,
    name: "ওমিচাঁদ",
    description: "চালাক অর্থলোভী ব্যাংকার, গোপনে শত্রুপক্ষের সাথে আঁতাতকারী।",
    color: "Red",
    team: "East India Company (EIC)"
  },
  {
    id: 5,
    name: "নবাব সিরাজউদ্দৌলা",
    description: "সাহসী ও দৃঢ়চেতা শাসক, মাতৃভূমি রক্ষায় দৃঢ় প্রতিজ্ঞ।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 6,
    name: "লুৎফুন্নিসা বেগম",
    description: "নবাবের বিশ্বস্ত সহধর্মিণী, রাজনীতি ও সিদ্ধান্তে প্রভাবশালী।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 7,
    name: "সাঁ ফ্রাঁ",
    description: "বিদেশি সামরিক উপদেষ্টা, রণকৌশলে দক্ষ ও অভিজ্ঞ।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 8,
    name: "মীর মদন",
    description: "নবাবের প্রতি অনুগত সাহসী সেনাপতি, যুদ্ধে অদম্য।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 9,
    name: "মোহনলাল",
    description: "বিশ্বস্ত সহচর ও যুদ্ধে কৌশল নির্ধারণে গুরুত্বপূর্ণ ভূমিকা পালনকারী।",
    color: "Green",
    team: "Nawabs"
  },
  {
    id: 10,
    name: "দেবশী",
    description: "নবাবের অনুগত সভাসদ ও রাজদরবারের পরামর্শদাতা।",
    color: "Green",
    team: "Nawabs"
  }
];

const fakeHistoricalNames = [
  "জগত শেঠ", "উমিচাঁদ", "খাজা ওয়াজিদ", "রাজবল্লভ",
  "সিরাজুল ইসলাম", "বদর আলী", "শওকত জং", "মুর্শিদ কুলি খান"
];

const MISSION_CONFIGS = {
  5: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 3, failsRequired: 1 }
  ],
  6: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 4, failsRequired: 1 }
  ],
  7: [
    { players: 2, failsRequired: 1 }, { players: 3, failsRequired: 1 },
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 4, failsRequired: 1 }
  ],
  8: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ],
  9: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ],
  10: [
    { players: 3, failsRequired: 1 }, { players: 4, failsRequired: 1 },
    { players: 4, failsRequired: 1 }, { players: 5, failsRequired: 2 }, // Round 4: 2 fails needed
    { players: 5, failsRequired: 1 }
  ]
};

// Nawab / Company seats for each battalion size (from startGame).
const TEAM_DISTRIBUTIONS = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };

const NAWAB_TEAM = "Nawabs";
const EIC_TEAM = "East India Company (EIC)";
const MIR_JAFOR_ID = 1;
const MIR_MADAN_ID = 8;

// The two possible winners, exactly as stored on the room and in the game logs.
const WINNER_NAWABS = "Nawabs (Green)";
const WINNER_EIC = "East India Company (Red)";

module.exports = {
  CharacterList,
  fakeHistoricalNames,
  MISSION_CONFIGS,
  TEAM_DISTRIBUTIONS,
  NAWAB_TEAM,
  EIC_TEAM,
  MIR_JAFOR_ID,
  MIR_MADAN_ID,
  WINNER_NAWABS,
  WINNER_EIC,
};
