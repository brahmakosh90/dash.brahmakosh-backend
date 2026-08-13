import express from 'express';
import { authenticate } from '../../middleware/auth.js';
import User from '../../models/User.js';
import Astrology from '../../models/Astrology.js';
import astrologyService from '../../services/astrologyService.js';

const router = express.Router();

const REPORT_TYPES = [
  'marriage', 'wealth', 'career', 'education', 'mental',
  'luck', 'travel', 'inner-self', 'health', 'challenges', 'past-life'
];

// ─── Helper: get planet by name ───────────────────────────────────────────────
const getPlanet = (planets = [], name) =>
  planets.find(p => p.name?.toLowerCase() === name.toLowerCase()) || null;

// ─── Helper: get house lord ───────────────────────────────────────────────────
const getHousePlanets = (birthChart, houseNum) => {
  if (!birthChart?.houses) return [];
  const houses = birthChart.houses;
  if (houses instanceof Map) return houses.get(String(houseNum)) || [];
  return houses[houseNum] || houses[String(houseNum)] || [];
};

// ─── Helper: get astrology data for user ─────────────────────────────────────
async function getAstrologyData(userId, profile) {
  let astroData = await Astrology.findOne({ userId }).lean();
  if (!astroData) {
    // fetch fresh if not cached
    const fresh = await astrologyService.getCompleteAstrologyData(userId, profile);
    astroData = await Astrology.findOne({ userId }).lean();
    if (!astroData) return fresh; // fallback to formatted response
  }
  return astroData;
}

// ─── Report generators ────────────────────────────────────────────────────────

function generateMarriageReport(astro) {
  const planets = astro.planets || [];
  const venus = getPlanet(planets, 'Venus');
  const jupiter = getPlanet(planets, 'Jupiter');
  const saturn = getPlanet(planets, 'Saturn');
  const house7 = getHousePlanets(astro.birthChart, 7);
  const ascendant = astro.astroDetails?.ascendant || '';
  const currentDasha = astro.currentVdasha;

  return {
    title: 'Marriage Report',
    ascendant,
    sevenHousePlanets: house7,
    venus: venus ? { sign: venus.sign, house: venus.house, nakshatra: venus.nakshatra, isRetro: venus.isRetro } : null,
    jupiter: jupiter ? { sign: jupiter.sign, house: jupiter.house } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house, isRetro: saturn.isRetro } : null,
    currentDasha: currentDasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
    sadhesati: astro.sadhesatiLifeDetails || null,
  };
}

function generateWealthReport(astro) {
  const planets = astro.planets || [];
  const jupiter = getPlanet(planets, 'Jupiter');
  const venus = getPlanet(planets, 'Venus');
  const mercury = getPlanet(planets, 'Mercury');
  const sun = getPlanet(planets, 'Sun');
  const house2 = getHousePlanets(astro.birthChart, 2);
  const house11 = getHousePlanets(astro.birthChart, 11);

  return {
    title: 'Wealth Report',
    secondHousePlanets: house2,
    eleventhHousePlanets: house11,
    jupiter: jupiter ? { sign: jupiter.sign, house: jupiter.house, nakshatra: jupiter.nakshatra } : null,
    venus: venus ? { sign: venus.sign, house: venus.house } : null,
    mercury: mercury ? { sign: mercury.sign, house: mercury.house } : null,
    sun: sun ? { sign: sun.sign, house: sun.house } : null,
    currentDasha: astro.currentVdasha || null,
    majorDasha: astro.majorVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
    sarvashtak: astro.sarvashtak || null,
  };
}

function generateCareerReport(astro) {
  const planets = astro.planets || [];
  const saturn = getPlanet(planets, 'Saturn');
  const sun = getPlanet(planets, 'Sun');
  const mars = getPlanet(planets, 'Mars');
  const mercury = getPlanet(planets, 'Mercury');
  const house10 = getHousePlanets(astro.birthChart, 10);
  const house6 = getHousePlanets(astro.birthChart, 6);

  return {
    title: 'Career Report',
    tenthHousePlanets: house10,
    sixthHousePlanets: house6,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house, isRetro: saturn.isRetro, nakshatra: saturn.nakshatra } : null,
    sun: sun ? { sign: sun.sign, house: sun.house } : null,
    mars: mars ? { sign: mars.sign, house: mars.house } : null,
    mercury: mercury ? { sign: mercury.sign, house: mercury.house } : null,
    ascendant: astro.astroDetails?.ascendant || '',
    ascendantLord: astro.astroDetails?.ascendantLord || '',
    currentDasha: astro.currentVdasha || null,
    majorDasha: astro.majorVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
  };
}

function generateEducationReport(astro) {
  const planets = astro.planets || [];
  const mercury = getPlanet(planets, 'Mercury');
  const jupiter = getPlanet(planets, 'Jupiter');
  const moon = getPlanet(planets, 'Moon');
  const house4 = getHousePlanets(astro.birthChart, 4);
  const house5 = getHousePlanets(astro.birthChart, 5);

  return {
    title: 'Education Report',
    fourthHousePlanets: house4,
    fifthHousePlanets: house5,
    mercury: mercury ? { sign: mercury.sign, house: mercury.house, nakshatra: mercury.nakshatra, isRetro: mercury.isRetro } : null,
    jupiter: jupiter ? { sign: jupiter.sign, house: jupiter.house, isRetro: jupiter.isRetro } : null,
    moon: moon ? { sign: moon.sign, house: moon.house, nakshatra: moon.nakshatra } : null,
    currentDasha: astro.currentVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
  };
}

function generateMentalReport(astro) {
  const planets = astro.planets || [];
  const moon = getPlanet(planets, 'Moon');
  const mercury = getPlanet(planets, 'Mercury');
  const saturn = getPlanet(planets, 'Saturn');
  const rahu = getPlanet(planets, 'Rahu');
  const house4 = getHousePlanets(astro.birthChart, 4);

  return {
    title: 'Mental Health Report',
    fourthHousePlanets: house4,
    moon: moon ? { sign: moon.sign, house: moon.house, nakshatra: moon.nakshatra, nakshatraLord: moon.nakshatraLord } : null,
    mercury: mercury ? { sign: mercury.sign, house: mercury.house, isRetro: mercury.isRetro } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house } : null,
    rahu: rahu ? { sign: rahu.sign, house: rahu.house } : null,
    astroDetails: {
      gan: astro.astroDetails?.gan || '',
      nadi: astro.astroDetails?.nadi || '',
      tatva: astro.astroDetails?.tatva || '',
    },
    sadhesati: astro.sadhesatiLifeDetails || null,
    currentDasha: astro.currentVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
  };
}

function generateLuckReport(astro) {
  const planets = astro.planets || [];
  const jupiter = getPlanet(planets, 'Jupiter');
  const sun = getPlanet(planets, 'Sun');
  const moon = getPlanet(planets, 'Moon');
  const house9 = getHousePlanets(astro.birthChart, 9);

  return {
    title: 'Luck Report',
    ninthHousePlanets: house9,
    jupiter: jupiter ? { sign: jupiter.sign, house: jupiter.house, nakshatra: jupiter.nakshatra } : null,
    sun: sun ? { sign: sun.sign, house: sun.house } : null,
    moon: moon ? { sign: moon.sign, house: moon.house } : null,
    astroDetails: {
      ascendant: astro.astroDetails?.ascendant || '',
      sign: astro.astroDetails?.sign || '',
      nakshatra: astro.astroDetails?.nakshatra || '',
      nakshatraLord: astro.astroDetails?.nakshatraLord || '',
      paya: astro.astroDetails?.paya || '',
      tatva: astro.astroDetails?.tatva || '',
      nameAlphabet: astro.astroDetails?.nameAlphabet || '',
    },
    currentDasha: astro.currentVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
    ghatChakra: astro.ghatChakra || null,
  };
}

function generateTravelReport(astro) {
  const planets = astro.planets || [];
  const rahu = getPlanet(planets, 'Rahu');
  const jupiter = getPlanet(planets, 'Jupiter');
  const saturn = getPlanet(planets, 'Saturn');
  const moon = getPlanet(planets, 'Moon');
  const house12 = getHousePlanets(astro.birthChart, 12);
  const house9 = getHousePlanets(astro.birthChart, 9);
  const house3 = getHousePlanets(astro.birthChart, 3);

  return {
    title: 'Travel Report',
    thirdHousePlanets: house3,
    ninthHousePlanets: house9,
    twelfthHousePlanets: house12,
    rahu: rahu ? { sign: rahu.sign, house: rahu.house } : null,
    jupiter: jupiter ? { sign: jupiter.sign, house: jupiter.house } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house } : null,
    moon: moon ? { sign: moon.sign, house: moon.house } : null,
    currentDasha: astro.currentVdasha || null,
    majorDasha: astro.majorVdasha || null,
  };
}

function generateInnerSelfReport(astro) {
  const planets = astro.planets || [];
  const sun = getPlanet(planets, 'Sun');
  const moon = getPlanet(planets, 'Moon');
  const saturn = getPlanet(planets, 'Saturn');
  const ketu = getPlanet(planets, 'Ketu');

  return {
    title: 'Inner Self Report',
    ascendant: astro.astroDetails?.ascendant || '',
    ascendantLord: astro.astroDetails?.ascendantLord || '',
    sun: sun ? { sign: sun.sign, house: sun.house, nakshatra: sun.nakshatra } : null,
    moon: moon ? { sign: moon.sign, house: moon.house, nakshatra: moon.nakshatra, nakshatraLord: moon.nakshatraLord } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house } : null,
    ketu: ketu ? { sign: ketu.sign, house: ketu.house } : null,
    astroDetails: {
      varna: astro.astroDetails?.varna || '',
      vashya: astro.astroDetails?.vashya || '',
      yoni: astro.astroDetails?.yoni || '',
      gan: astro.astroDetails?.gan || '',
      nadi: astro.astroDetails?.nadi || '',
      tatva: astro.astroDetails?.tatva || '',
    },
    currentDasha: astro.currentVdasha || null,
    currentYoginiDasha: astro.currentYoginiDasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
  };
}

function generateHealthReport(astro) {
  const planets = astro.planets || [];
  const sun = getPlanet(planets, 'Sun');
  const moon = getPlanet(planets, 'Moon');
  const mars = getPlanet(planets, 'Mars');
  const saturn = getPlanet(planets, 'Saturn');
  const house1 = getHousePlanets(astro.birthChart, 1);
  const house6 = getHousePlanets(astro.birthChart, 6);
  const house8 = getHousePlanets(astro.birthChart, 8);

  return {
    title: 'Health Report',
    firstHousePlanets: house1,
    sixthHousePlanets: house6,
    eighthHousePlanets: house8,
    ascendant: astro.astroDetails?.ascendant || '',
    ascendantLord: astro.astroDetails?.ascendantLord || '',
    sun: sun ? { sign: sun.sign, house: sun.house } : null,
    moon: moon ? { sign: moon.sign, house: moon.house, nakshatra: moon.nakshatra } : null,
    mars: mars ? { sign: mars.sign, house: mars.house } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house, isRetro: saturn.isRetro } : null,
    astroDetails: {
      tatva: astro.astroDetails?.tatva || '',
      nadi: astro.astroDetails?.nadi || '',
    },
    sadhesati: astro.sadhesatiLifeDetails || null,
    currentDasha: astro.currentVdasha || null,
    gemstoneSuggestion: astro.gemstoneSuggestion || null,
  };
}

function generateChallengesReport(astro) {
  const planets = astro.planets || [];
  const saturn = getPlanet(planets, 'Saturn');
  const rahu = getPlanet(planets, 'Rahu');
  const ketu = getPlanet(planets, 'Ketu');
  const mars = getPlanet(planets, 'Mars');
  const house6 = getHousePlanets(astro.birthChart, 6);
  const house8 = getHousePlanets(astro.birthChart, 8);
  const house12 = getHousePlanets(astro.birthChart, 12);

  return {
    title: 'Challenges Report',
    sixthHousePlanets: house6,
    eighthHousePlanets: house8,
    twelfthHousePlanets: house12,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house, isRetro: saturn.isRetro, nakshatra: saturn.nakshatra } : null,
    rahu: rahu ? { sign: rahu.sign, house: rahu.house } : null,
    ketu: ketu ? { sign: ketu.sign, house: ketu.house } : null,
    mars: mars ? { sign: mars.sign, house: mars.house, isRetro: mars.isRetro } : null,
    sadhesati: astro.sadhesatiLifeDetails || null,
    pitraDoshaReport: astro.pitraDoshaReport || null,
    currentDasha: astro.currentVdasha || null,
    majorDasha: astro.majorVdasha || null,
  };
}

function generatePastLifeReport(astro) {
  const planets = astro.planets || [];
  const ketu = getPlanet(planets, 'Ketu');
  const saturn = getPlanet(planets, 'Saturn');
  const rahu = getPlanet(planets, 'Rahu');
  const moon = getPlanet(planets, 'Moon');
  const house12 = getHousePlanets(astro.birthChart, 12);

  return {
    title: 'Past Life Report',
    twelfthHousePlanets: house12,
    ketu: ketu ? { sign: ketu.sign, house: ketu.house, nakshatra: ketu.nakshatra } : null,
    saturn: saturn ? { sign: saturn.sign, house: saturn.house, isRetro: saturn.isRetro } : null,
    rahu: rahu ? { sign: rahu.sign, house: rahu.house } : null,
    moon: moon ? { sign: moon.sign, house: moon.house, nakshatra: moon.nakshatra } : null,
    pitraDoshaReport: astro.pitraDoshaReport || null,
    sadhesati: astro.sadhesatiLifeDetails || null,
    astroDetails: {
      varna: astro.astroDetails?.varna || '',
      gan: astro.astroDetails?.gan || '',
      nadi: astro.astroDetails?.nadi || '',
    },
    currentDasha: astro.currentVdasha || null,
  };
}

const reportGenerators = {
  marriage: generateMarriageReport,
  wealth: generateWealthReport,
  career: generateCareerReport,
  education: generateEducationReport,
  mental: generateMentalReport,
  luck: generateLuckReport,
  travel: generateTravelReport,
  'inner-self': generateInnerSelfReport,
  health: generateHealthReport,
  challenges: generateChallengesReport,
  'past-life': generatePastLifeReport,
};

// ─── GET /api/mobile/user/reports/astrology ───────────────────────────────────
// Get raw astrology base data for the user
router.get('/astrology', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const user = await User.findById(req.user._id).select('profile liveLocation').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const profile = {
      ...user.profile,
      latitude: user.liveLocation?.latitude ?? user.profile?.latitude,
      longitude: user.liveLocation?.longitude ?? user.profile?.longitude,
    };

    if (!profile.dob || !profile.timeOfBirth || profile.latitude == null || profile.longitude == null) {
      return res.status(400).json({
        success: false,
        message: 'Birth details incomplete. Please update dob, timeOfBirth, latitude, and longitude in your profile.',
        missingFields: [
          !profile.dob && 'dob',
          !profile.timeOfBirth && 'timeOfBirth',
          profile.latitude == null && 'latitude',
          profile.longitude == null && 'longitude',
        ].filter(Boolean),
      });
    }

    const astroData = await astrologyService.getCompleteAstrologyData(req.user._id, profile);

    res.json({ success: true, data: astroData });
  } catch (error) {
    console.error('[Reports] astrology error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch astrology data' });
  }
});

// ─── GET /api/mobile/user/reports ─────────────────────────────────────────────
// List all available report types
router.get('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const astroExists = await Astrology.exists({ userId: req.user._id });

    res.json({
      success: true,
      data: {
        astrologyDataReady: !!astroExists,
        availableReports: REPORT_TYPES.map(type => ({
          type,
          title: reportGenerators[type]({ astroDetails: {}, planets: [], birthChart: { houses: {} } }).title,
          endpoint: `/api/mobile/user/reports/${type}`,
        })),
      },
    });
  } catch (error) {
    console.error('[Reports] list error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to list reports' });
  }
});

// ─── POST /api/mobile/user/reports/:reportType ────────────────────────────────
// Generate a specific report
router.post('/:reportType', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const { reportType } = req.params;

    if (!REPORT_TYPES.includes(reportType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid report type. Valid types: ${REPORT_TYPES.join(', ')}`,
      });
    }

    const user = await User.findById(req.user._id).select('profile liveLocation').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const profile = {
      ...user.profile,
      latitude: user.liveLocation?.latitude ?? user.profile?.latitude,
      longitude: user.liveLocation?.longitude ?? user.profile?.longitude,
    };

    if (!profile.dob || !profile.timeOfBirth || profile.latitude == null || profile.longitude == null) {
      return res.status(400).json({
        success: false,
        message: 'Birth details incomplete. Please update dob, timeOfBirth, latitude, and longitude in your profile.',
        missingFields: [
          !profile.dob && 'dob',
          !profile.timeOfBirth && 'timeOfBirth',
          profile.latitude == null && 'latitude',
          profile.longitude == null && 'longitude',
        ].filter(Boolean),
      });
    }

    const astroData = await getAstrologyData(req.user._id, profile);
    const reportData = reportGenerators[reportType](astroData);

    res.json({
      success: true,
      reportType,
      generatedAt: new Date().toISOString(),
      data: reportData,
    });
  } catch (error) {
    console.error(`[Reports] ${req.params.reportType} error:`, error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate report' });
  }
});

export default router;
