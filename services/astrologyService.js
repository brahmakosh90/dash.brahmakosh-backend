// src/services/astrologyService.js

import axios from 'axios';
import Astrology from '../models/Astrology.js';

class AstrologyService {
  constructor() {
    this.baseUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    this.apiKey = process.env.ASTROLOGY_API_KEY;

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-astrologyapi-key': this.apiKey
      },
      timeout: 30000
    });
  }

  /**
   * Main method: Get complete astrology data
   * Checks DB first, then fetches from API if needed
   */

  
  async getCompleteAstrologyData(userId, profile, forceRefresh = false) {
    try {
      // Step 1: Check if data exists in DB (unless force refresh)
      if (!forceRefresh) {
        const existingData = await Astrology.findOne({ userId });
        if (existingData) {
          console.log('[Astrology Service] Returning cached data from DB for user:', userId);
          return this.formatAstrologyResponse(existingData);
        }
        console.log('[Astrology Service] No cached data found, fetching from API');
      } else {
        console.log('[Astrology Service] Force refresh requested, fetching fresh data from API');
      }

      // Step 2: Validate profile data
      this.validateBirthDetails(profile);

      // Step 3: Prepare birth data for API
      const birthData = this.prepareBirthData(profile);

      // Step 4: Fetch core endpoints — birth_details first (sensitive to concurrency)
      console.log('[Astrology Service] Fetching core API endpoints...');
      const birthDetailsData = await this.fetchBirthDetails(birthData);
      await this.delay(300);

      const [astroDetailsData, planetsData, planetsExtendedData] = await Promise.all([
        this.fetchAstroDetails(birthData),
        this.fetchPlanets(birthData),
        this.fetchPlanetsExtended(birthData),
      ]);
      await this.delay(500);

      // Step 5: Fetch extended data in batches
      console.log('[Astrology Service] Fetching extended API endpoints in batches...');
      const extendedData = await this.fetchAllExtendedAstrologyData(birthData);

      console.log('[Astrology Service] All API calls completed successfully');

      // Step 5: Process and structure the data
      const astrologyData = this.processAstrologyData(
        userId,
        profile,
        birthDetailsData,
        astroDetailsData,
        planetsData,
        planetsExtendedData,
        extendedData
      );

      // Step 6: Save to database
      const savedData = await Astrology.findOneAndUpdate(
        { userId },
        astrologyData,
        { upsert: true, new: true }
      );

      console.log('[Astrology Service] Data saved to DB for user:', userId);

      // Step 7: Return formatted response
      return this.formatAstrologyResponse(savedData);

    } catch (error) {
      console.error('[Astrology Service] Error:', error);
      throw new Error(`Failed to get astrology data: ${error.message}`);
    }
  }

  /**
   * Validate birth details
   */
  validateBirthDetails(profile) {
    if (!profile?.dob || !profile?.timeOfBirth || 
        profile?.latitude === null || profile?.latitude === undefined ||
        profile?.longitude === null || profile?.longitude === undefined) {
      throw new Error('Incomplete birth details: dob, timeOfBirth, latitude, and longitude are required');
    }
  }

  /**
   * Prepare birth data for API request (JSON format)
   */
  prepareBirthData(profile) {
    const birthDate = new Date(profile.dob);
    
    // Parse time - handle both "4:45 AM" and "04:45" formats
    let hours, minutes;
    const timeStr = profile.timeOfBirth.trim();
    
    if (timeStr.includes('AM') || timeStr.includes('PM')) {
      // 12-hour format: "4:45 AM" or "11:30 PM"
      const [time, period] = timeStr.split(' ');
      const [h, m] = time.split(':').map(Number);
      
      hours = h;
      if (period === 'PM' && hours !== 12) {
        hours += 12;
      } else if (period === 'AM' && hours === 12) {
        hours = 0;
      }
      minutes = m;
    } else {
      // 24-hour format: "16:30"
      [hours, minutes] = timeStr.split(':').map(Number);
    }
    
    return {
      day: birthDate.getDate(),
      month: birthDate.getMonth() + 1,
      year: birthDate.getFullYear(),
      hour: hours,
      min: minutes,
      lat: parseFloat(profile.latitude),
      lon: parseFloat(profile.longitude),
      tzone: 5.5 // Indian Standard Time, adjust as needed
    };
  }

  /**
   * Fetch birth details from API
   * Endpoint: /birth_details
   */
  async fetchBirthDetails(birthData) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Astrology Service] Fetching birth_details (attempt ${attempt})...`);
        const response = await this.apiClient.post('/birth_details', birthData);
        return response.data;
      } catch (error) {
        if (error.response?.status === 429 && attempt < 3) {
          console.warn(`[Astrology Service] birth_details 429, retrying in ${attempt * 1000}ms...`);
          await this.delay(attempt * 1000);
        } else {
          console.error('[Astrology Service] Birth details error:', error.response?.data || error.message);
          throw new Error(`Failed to fetch birth details: ${error.message}`);
        }
      }
    }
  }

  /**
   * Fetch astro details from API
   * Endpoint: /astro_details
   */
  async fetchAstroDetails(birthData) {
    try {
      console.log('[Astrology Service] Fetching astro_details...');
      const response = await this.apiClient.post('/astro_details', birthData);
      return response.data;
    } catch (error) {
      console.error('[Astrology Service] Astro details error:', error.response?.data || error.message);
      throw new Error(`Failed to fetch astro details: ${error.message}`);
    }
  }

  /**
   * Fetch planets from API
   * Endpoint: /planets
   */
  async fetchPlanets(birthData) {
    try {
      console.log('[Astrology Service] Fetching planets...');
      const response = await this.apiClient.post('/planets', birthData);
      return response.data;
    } catch (error) {
      console.error('[Astrology Service] Planets error:', error.response?.data || error.message);
      throw new Error(`Failed to fetch planets: ${error.message}`);
    }
  }

  /**
   * Fetch extended planets from API
   * Endpoint: /planets/extended
   */
  async fetchPlanetsExtended(birthData) {
    try {
      console.log('[Astrology Service] Fetching planets/extended...');
      const response = await this.apiClient.post('/planets/extended', birthData);
      return response.data;
    } catch (error) {
      console.error('[Astrology Service] Extended planets error:', error.response?.data || error.message);
      throw new Error(`Failed to fetch extended planets: ${error.message}`);
    }
  }

  /**
   * Fetch additional astrology APIs (non-blocking - failures don't break main flow)
   */
  async fetchGhatChakra(birthData) {
    try {
      const response = await this.apiClient.post('/ghat_chakra', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] ghat_chakra error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchAyanamsha(birthData) {
    try {
      const response = await this.apiClient.post('/ayanamsha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] ayanamsha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchBhavMadhya(birthData) {
    try {
      const response = await this.apiClient.post('/bhav_madhya', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] bhav_madhya error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchPlanetNature(birthData) {
    try {
      // Correct endpoint name is 'planets_nature' (plural), not 'planet_nature'
      const response = await this.apiClient.post('/planets_nature', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] planets_nature error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchPanchadaMaitri(birthData) {
    try {
      const response = await this.apiClient.post('/panchada_maitri', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] panchada_maitri error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchPlanetAshtak(birthData, planetName) {
    try {
      const response = await this.apiClient.post(`/planet_ashtak/${planetName}`, birthData);
      return response.data;
    } catch (error) {
      console.warn(`[Astrology Service] planet_ashtak/${planetName} error:`, error.response?.data || error.message);
      return null;
    }
  }

  async fetchSarvashtak(birthData) {
    try {
      const response = await this.apiClient.post('/sarvashtak', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] sarvashtak error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchCurrentVdasha(birthData) {
    try {
      const response = await this.apiClient.post('/current_vdasha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] current_vdasha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchCurrentVdashaAll(birthData) {
    try {
      const response = await this.apiClient.post('/current_vdasha_all', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] current_vdasha_all error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchMajorVdasha(birthData) {
    try {
      const response = await this.apiClient.post('/major_vdasha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] major_vdasha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchCurrentChardasha(birthData) {
    try {
      const response = await this.apiClient.post('/current_chardasha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] current_chardasha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchMajorChardasha(birthData) {
    try {
      const response = await this.apiClient.post('/major_chardasha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] major_chardasha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchCurrentYoginiDasha(birthData) {
    try {
      const response = await this.apiClient.post('/current_yogini_dasha', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] current_yogini_dasha error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchSadhesatiLifeDetails(birthData) {
    try {
      const response = await this.apiClient.post('/sadhesati_life_details', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] sadhesati_life_details error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchPitraDoshaReport(birthData) {
    try {
      const response = await this.apiClient.post('/pitra_dosha_report', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] pitra_dosha_report error:', error.response?.data || error.message);
      return null;
    }
  }

  async fetchGemstoneSuggestion(birthData) {
    try {
      const response = await this.apiClient.post('/basic_gem_suggestion', birthData);
      return response.data;
    } catch (error) {
      console.warn('[Astrology Service] basic_gem_suggestion error:', error.response?.data || error.message);
      return null;
    }
  }

  delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  /**
   * Fetch all extended astrology data in sequential batches to avoid 429 rate limit
   */
  async fetchAllExtendedAstrologyData(birthData) {
    // Batch 1: basic extended data (5 calls)
    const [ghatChakra, ayanamsha, bhavMadhya, planetNature, panchadaMaitri] = await Promise.all([
      this.fetchGhatChakra(birthData),
      this.fetchAyanamsha(birthData),
      this.fetchBhavMadhya(birthData),
      this.fetchPlanetNature(birthData),
      this.fetchPanchadaMaitri(birthData),
    ]);
    await this.delay(500);

    // Batch 2: planet ashtak (9 calls) in 3 groups of 3
    const planetGroups = [['sun','moon','mars'], ['mercury','jupiter','venus'], ['saturn','rahu','ketu']];
    const planetAshtak = {};
    for (const group of planetGroups) {
      const results = await Promise.all(group.map(p => this.fetchPlanetAshtak(birthData, p).then(data => ({ planet: p, data }))));
      results.forEach(({ planet, data }) => { if (data) planetAshtak[planet] = data; });
      await this.delay(400);
    }

    // Batch 3: dasha & other data (5 calls)
    const [sarvashtak, currentVdasha, currentVdashaAll, majorVdasha, currentChardasha] = await Promise.all([
      this.fetchSarvashtak(birthData),
      this.fetchCurrentVdasha(birthData),
      this.fetchCurrentVdashaAll(birthData),
      this.fetchMajorVdasha(birthData),
      this.fetchCurrentChardasha(birthData),
    ]);
    await this.delay(400);

    // Batch 4: remaining (5 calls)
    const [majorChardasha, currentYoginiDasha, sadhesatiLifeDetails, pitraDoshaReport, gemstoneSuggestion] = await Promise.all([
      this.fetchMajorChardasha(birthData),
      this.fetchCurrentYoginiDasha(birthData),
      this.fetchSadhesatiLifeDetails(birthData),
      this.fetchPitraDoshaReport(birthData),
      this.fetchGemstoneSuggestion(birthData),
    ]);

    return {
      ghatChakra, ayanamsha, bhavMadhya, planetNature, panchadaMaitri,
      planetAshtak: Object.keys(planetAshtak).length ? planetAshtak : null,
      sarvashtak, currentVdasha, currentVdashaAll, majorVdasha, currentChardasha,
      majorChardasha, currentYoginiDasha, sadhesatiLifeDetails, pitraDoshaReport, gemstoneSuggestion
    };
  }

  /**
   * Process and structure astrology data from all API responses
   */
  processAstrologyData(userId, profile, birthDetailsData, astroDetailsData, planetsData, planetsExtendedData, extendedData = {}) {
    const birthDate = new Date(profile.dob);
    
    // Parse time - handle both "4:45 AM" and "04:45" formats
    let hour, minute;
    const timeStr = profile.timeOfBirth.trim();
    
    if (timeStr.includes('AM') || timeStr.includes('PM')) {
      const [time, period] = timeStr.split(' ');
      const [h, m] = time.split(':').map(Number);
      
      hour = h;
      if (period === 'PM' && hour !== 12) {
        hour += 12;
      } else if (period === 'AM' && hour === 12) {
        hour = 0;
      }
      minute = m;
    } else {
      [hour, minute] = timeStr.split(':').map(Number);
    }

    return {
      userId,
      birthDetails: {
        day: birthDetailsData.day || birthDate.getDate(),
        month: birthDetailsData.month || (birthDate.getMonth() + 1),
        year: birthDetailsData.year || birthDate.getFullYear(),
        hour: birthDetailsData.hour || hour,
        minute: birthDetailsData.minute || minute,
        latitude: parseFloat(profile.latitude),
        longitude: parseFloat(profile.longitude),
        ayanamsha: birthDetailsData.ayanamsha || 0,
        sunrise: birthDetailsData.sunrise || '06:00',
        sunset: birthDetailsData.sunset || '18:00'
      },
      astroDetails: {
        // Primary details
        ascendant: astroDetailsData.ascendant || '',
        ascendantLord: astroDetailsData.ascendant_lord || '',
        sign: astroDetailsData.sign || '',
        signLord: astroDetailsData.SignLord || astroDetailsData.sign_lord || '',
        
        // Nakshatra details
        nakshatra: astroDetailsData.Naksahtra || astroDetailsData.nakshatra || '',
        nakshatraLord: astroDetailsData.NaksahtraLord || astroDetailsData.Naksahtra_lord || astroDetailsData.nakshatra_lord || '',
        charan: (astroDetailsData.Charan || astroDetailsData.charan || '').toString(),
        
        // Vedic classifications
        varna: astroDetailsData.Varna || astroDetailsData.varna || '',
        vashya: astroDetailsData.Vashya || astroDetailsData.vashya || '',
        yoni: astroDetailsData.Yoni || astroDetailsData.yoni || '',
        gan: astroDetailsData.Gan || astroDetailsData.gan || '',
        nadi: astroDetailsData.Nadi || astroDetailsData.nadi || '',
        
        // Panchang details
        tithi: astroDetailsData.Tithi || astroDetailsData.tithi || '',
        yog: astroDetailsData.Yog || astroDetailsData.yog || '',
        karan: astroDetailsData.Karan || astroDetailsData.karan || '',
        
        // Additional attributes
        yunja: astroDetailsData.yunja || '',
        tatva: astroDetailsData.tatva || '',
        nameAlphabet: astroDetailsData.name_alphabet || '',
        paya: astroDetailsData.paya || ''
      },
      planets: this.normalizePlanets(planetsData),
      planetsExtended: this.normalizePlanetsExtended(planetsExtendedData),
      birthChart: this.generateBirthChart(planetsData),
      birthExtendedChart: this.generateBirthChart(planetsExtendedData),
      // Extended astrology data
      ghatChakra: extendedData?.ghatChakra || null,
      ayanamsha: extendedData?.ayanamsha || null,
      bhavMadhya: extendedData?.bhavMadhya || null,
      planetNature: extendedData?.planetNature || null,
      panchadaMaitri: extendedData?.panchadaMaitri || null,
      planetAshtak: extendedData?.planetAshtak || null,
      sarvashtak: extendedData?.sarvashtak || null,
      currentVdasha: extendedData?.currentVdasha || null,
      currentVdashaAll: extendedData?.currentVdashaAll || null,
      majorVdasha: extendedData?.majorVdasha || null,
      currentChardasha: extendedData?.currentChardasha || null,
      majorChardasha: extendedData?.majorChardasha || null,
      currentYoginiDasha: extendedData?.currentYoginiDasha || null,
      sadhesatiLifeDetails: extendedData?.sadhesatiLifeDetails || null,
      pitraDoshaReport: extendedData?.pitraDoshaReport || null,
      gemstoneSuggestion: extendedData?.gemstoneSuggestion || null,
      lastCalculated: new Date(),
      calculationSource: 'api'
    };
  }

  /**
   * Normalize planets data from API to match schema
   */
  normalizePlanets(planetsData) {
    // Handle both array and object responses
    const planetsArray = Array.isArray(planetsData) ? planetsData : Object.values(planetsData);
    
    return planetsArray
      .filter(planet => planet && planet.name)
      .map((planet, index) => ({
        id: planet.id !== undefined ? planet.id : index,
        name: planet.name,
        fullDegree: planet.fullDegree || planet.full_degree || 0,
        normDegree: planet.normDegree || planet.norm_degree || 0,
        speed: planet.speed || 0,
        isRetro: (planet.isRetro || planet.is_retro || planet.isRetro === false ? 'false' : 'false').toString(),
        sign: planet.sign || '',
        signLord: planet.signLord || planet.sign_lord || '',
        nakshatra: planet.nakshatra || '',
        nakshatraLord: planet.nakshatraLord || planet.nakshatra_lord || '',
        nakshatra_pad: planet.nakshatra_pad || 0,
        house: planet.house || 0,
        is_planet_set: planet.is_planet_set || false,
        planet_awastha: planet.planet_awastha || 'Neutral'
      }));
  }

  /**
   * Normalize extended planets data from API
   */
  normalizePlanetsExtended(planetsData) {
    // Handle both array and object responses
    const planetsArray = Array.isArray(planetsData) ? planetsData : Object.values(planetsData);
    
    return planetsArray
      .filter(planet => planet && planet.name)
      .map((planet, index) => ({
        id: planet.id || index,
        name: planet.name,
        fullDegree: planet.fullDegree || planet.full_degree || 0,
        normDegree: planet.normDegree || planet.norm_degree || 0,
        speed: planet.speed || 0,
        isRetro: (planet.isRetro || planet.is_retro || 'false').toString(),
        sign: planet.sign || '',
        signLord: planet.signLord || planet.sign_lord || '',
        nakshatra: planet.nakshatra || '',
        nakshatraLord: planet.nakshatraLord || planet.nakshatra_lord || '',
        nakshatra_pad: planet.nakshatra_pad || 0,
        house: planet.house || 0,
        is_planet_set: planet.is_planet_set || false,
        planet_awastha: planet.planet_awastha || 'Neutral'
      }));
  }

  /**
   * Generate birth chart from planets data
   */
  generateBirthChart(planetsData) {
    const houses = {};
    
    // Initialize all 12 houses
    for (let i = 1; i <= 12; i++) {
      houses[i] = [];
    }

    // Handle both array and object responses
    const planetsArray = Array.isArray(planetsData) ? planetsData : Object.values(planetsData);

    // Place planets in houses (excluding Ascendant from chart display)
    planetsArray.forEach(planet => {
      if (planet && planet.house && planet.house >= 1 && planet.house <= 12) {
        // Exclude Ascendant from chart display but keep other planets
        if (!['Ascendant', 'ASCENDANT'].includes(planet.name)) {
          houses[planet.house].push(planet.name);
        }
      }
    });

    return { houses };
  }

  /**
   * Format astrology response from DB document
   */
  formatAstrologyResponse(astrologyDoc) {
    const obj = astrologyDoc.toObject();
    
    // Convert Map to Object for houses
    const formatHouses = (housesMap) => {
      if (!housesMap) return {};
      const formatted = {};
      for (let i = 1; i <= 12; i++) {
        formatted[i] = housesMap.get(i.toString()) || [];
      }
      return formatted;
    };

    return {
      birthDetails: obj.birthDetails,
      astroDetails: obj.astroDetails,
      planets: obj.planets,
      planetsExtended: obj.planetsExtended,
      birthChart: {
        houses: formatHouses(obj.birthChart?.houses)
      },
      birthExtendedChart: {
        houses: formatHouses(obj.birthExtendedChart?.houses)
      },
      // Extended astrology data
      ghatChakra: obj.ghatChakra,
      ayanamsha: obj.ayanamsha,
      bhavMadhya: obj.bhavMadhya,
      planetNature: obj.planetNature,
      panchadaMaitri: obj.panchadaMaitri,
      planetAshtak: obj.planetAshtak,
      sarvashtak: obj.sarvashtak,
      currentVdasha: obj.currentVdasha,
      currentVdashaAll: obj.currentVdashaAll,
      majorVdasha: obj.majorVdasha,
      currentChardasha: obj.currentChardasha,
      majorChardasha: obj.majorChardasha,
      currentYoginiDasha: obj.currentYoginiDasha,
      sadhesatiLifeDetails: obj.sadhesatiLifeDetails,
      pitraDoshaReport: obj.pitraDoshaReport,
      gemstoneSuggestion: obj.gemstoneSuggestion,
      lastCalculated: obj.lastCalculated,
      calculationSource: obj.calculationSource
    };
  }

  /**
   * Delete astrology data for a user
   */
  async deleteAstrologyData(userId) {
    try {
      await Astrology.findOneAndDelete({ userId });
      console.log('[Astrology Service] Deleted astrology data for user:', userId);
    } catch (error) {
      console.error('[Astrology Service] Delete error:', error);
      throw error;
    }
  }

  /**
   * Refresh astrology data (force recalculation from API)
   */
  async refreshAstrologyData(userId, profile) {
    console.log('[Astrology Service] Refreshing data for user:', userId);
    return this.getCompleteAstrologyData(userId, profile, true);
  }
}

export default new AstrologyService();