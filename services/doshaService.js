// src/services/doshaService.js
// Fetches all Indian Astrology Dosha APIs and combines results

import axios from 'axios';
import Dosha from '../models/Dosha.js';

// API endpoints (requested set)
// Doshas:
// 1. manglik
// 2. kalsarpa_details
// 3. sadhesati_current_status
// 4. sadhesati_life_details
// 5. pitra_dosha_report
// Dashas:
// - current_yogini_dasha
// - current_chardasha
// - major_chardasha
const DOSHA_ENDPOINTS = {
  manglik: '/manglik',  
  kalsarpa: '/kalsarpa_details',
  sadeSatiCurrent: '/sadhesati_current_status',
  sadeSatiLife: '/sadhesati_life_details',
  pitra: '/pitra_dosha_report'
};

const DASHA_ENDPOINTS = {
  currentYogini: '/current_yogini_dasha',
  currentChardasha: '/current_chardasha',
  majorChardasha: '/major_chardasha'
};

class DoshaService {
  constructor() {
    this.baseUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    this.apiUserId = process.env.ASTROLOGY_API_USER_ID;
    this.apiKey = process.env.ASTROLOGY_API_KEY;

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      headers: { 'Content-Type': 'application/json', 'x-astrologyapi-key': this.apiKey },
      timeout: 30000
    });
  }

  /**
   * Prepare birth data for Dosha APIs from user profile
   * Uses: profile.dob, profile.timeOfBirth, liveLocation.latitude, liveLocation.longitude
   */
  prepareBirthData(user) {
    const profile = user.profile || {};
    const liveLocation = user.liveLocation || {};
    const dob = profile.dob;

    if (!dob) {
      throw new Error('User profile must have date of birth (dob)');
    }

    const birthDate = new Date(dob);
    if (isNaN(birthDate.getTime())) {
      throw new Error('Invalid date of birth');
    }

    const lat = liveLocation.latitude ?? profile.latitude ?? 28.6139;
    const lon = liveLocation.longitude ?? profile.longitude ?? 77.209;

    let hour = 12;
    let minute = 30;
    const timeStr = (profile.timeOfBirth || '12:30').toString().trim();
    if (timeStr) {
      if (timeStr.includes('AM') || timeStr.includes('PM')) {
        const [time, period] = timeStr.split(' ');
        const [h, m] = (time || '12:30').split(':').map(Number);
        hour = h || 12;
        minute = m || 30;
        if (period === 'PM' && hour !== 12) hour += 12;
        else if (period === 'AM' && hour === 12) hour = 0;
      } else {
        [hour, minute] = timeStr.split(':').map(Number);
        hour = hour ?? 12;
        minute = minute ?? 30;
      }
    }

    return {
      day: birthDate.getDate(),
      month: birthDate.getMonth() + 1,
      year: birthDate.getFullYear(),
      hour,
      min: minute,
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      tzone: 5.5
    };
  }

  /**
   * Call a single dosha API
   */
  async fetchDosha(name, birthData) {
    const endpoint = DOSHA_ENDPOINTS[name];
    if (!endpoint) return { error: `Unknown dosha: ${name}` };

    try {
      const response = await this.apiClient.post(endpoint, birthData);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`[Dosha Service] ${name} error:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        data: null
      };
    }
  }

  /**
   * Call a single dasha API
   */
  async fetchDasha(name, birthData) {
    const endpoint = DASHA_ENDPOINTS[name];
    if (!endpoint) return { error: `Unknown dasha: ${name}` };

    try {
      const response = await this.apiClient.post(endpoint, birthData);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`[Dasha Service] ${name} error:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        data: null
      };
    }
  }

  /**
   * Get all dosha data for a user (from User model)
   * Caches all dosha/dasha data in DB; reuses cached result unless forceRefresh is true.
   * @param {Object} user - User document (must include profile + liveLocation)
   * @param {Object} options - { forceRefresh?: boolean }
   */
  async getAllDoshas(user, options = {}) {
    const { forceRefresh = false } = options;
    const birthData = this.prepareBirthData(user);
    const userId = user?._id || user?.id;

    // Use cached value if available and valid, unless forcing refresh
    if (userId && !forceRefresh) {
      const existing = await Dosha.findOne({ userId }).lean();
      const hasDoshas =
        existing?.doshas && Object.keys(existing.doshas).length > 0;
      const hasDashas =
        existing?.dashas && Object.keys(existing.dashas).length > 0;
      const hasSimpleManglik =
        !!(existing?.doshas && Object.prototype.hasOwnProperty.call(existing.doshas, 'simpleManglik'));

      // Only reuse cache if:
      // - we have doshas
      // - we have dashas
      // - and there is NO legacy simpleManglik field
      if (hasDoshas && hasDashas && !hasSimpleManglik) {
        return {
          birthData: existing.birthData || birthData,
          doshas: existing.doshas || {},
          dashas: existing.dashas || {},
          summary: existing.summary || {}
        };
      }
    }

    // Fetch all doshas
    const [
      resManglik,
      resKalsarpa,
      resSadeSatiCurrent,
      resSadeSatiLife,
      resPitra
    ] = await Promise.all([
      this.fetchDosha('manglik', birthData),
      this.fetchDosha('kalsarpa', birthData),
      this.fetchDosha('sadeSatiCurrent', birthData),
      this.fetchDosha('sadeSatiLife', birthData),
      this.fetchDosha('pitra', birthData)
    ]);

    const manglik = resManglik.success && resManglik.data ? this.normalizeManglik(resManglik.data) : { present: false, error: resManglik.error };
    const kalsarpa = resKalsarpa.success && resKalsarpa.data ? this.normalizeKalsarpa(resKalsarpa.data) : { present: false, error: resKalsarpa.error };
    const sadeSatiCurrent = resSadeSatiCurrent.success && resSadeSatiCurrent.data ? this.normalizeSadeSati(resSadeSatiCurrent.data) : { present: false, error: resSadeSatiCurrent.error };
    const sadeSatiLife = resSadeSatiLife.success && resSadeSatiLife.data ? this.normalizeSadeSati(resSadeSatiLife.data) : { present: false, error: resSadeSatiLife.error };
    const pitra = resPitra.success && resPitra.data ? this.normalizePitra(resPitra.data) : { present: false, error: resPitra.error };

    const doshas = {
      manglik,
      kalsarpa,
      sadeSatiCurrent,
      sadeSatiLife,
      pitra
    };

    // Fetch dashas
    const [
      resCurrentYogini,
      resCurrentChardasha,
      resMajorChardasha
    ] = await Promise.all([
      this.fetchDasha('currentYogini', birthData),
      this.fetchDasha('currentChardasha', birthData),
      this.fetchDasha('majorChardasha', birthData)
    ]);

    const dashas = {
      currentYogini: resCurrentYogini.success ? resCurrentYogini.data : { error: resCurrentYogini.error },
      currentChardasha: resCurrentChardasha.success ? resCurrentChardasha.data : { error: resCurrentChardasha.error },
      majorChardasha: resMajorChardasha.success ? resMajorChardasha.data : { error: resMajorChardasha.error }
    };

    const summary = {
      manglik: !!manglik?.present,
      kalsarpa: !!kalsarpa?.present,
      sadeSatiCurrent: !!sadeSatiCurrent?.present,
      sadeSatiLife: !!sadeSatiLife?.present,
      pitra: !!pitra?.present,
      anyPresent: Object.values(doshas).some(d => d && d.present)
    };

    if (userId) {
      await Dosha.findOneAndUpdate(
        { userId },
        {
          userId,
          birthData,
          doshas,
          dashas,
          summary,
          lastFetched: new Date()
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    return {
      birthData: {
        day: birthData.day,
        month: birthData.month,
        year: birthData.year,
        hour: birthData.hour,
        min: birthData.min,
        lat: birthData.lat,
        lon: birthData.lon,
        tzone: birthData.tzone
      },
      doshas,
      dashas,
      summary
    };
  }

  normalizeKalsarpa(data) {
    const present = !!(data?.kalsarpa_present || data?.kalsarpa_status);
    return {
      present,
      status: data?.kalsarpa_status || data?.status || null,
      type: data?.kalsarpa_type || data?.type || null,
      description: data?.description || data?.remedy || null,
      raw: data
    };
  }

  normalizeManglik(data) {
    const present = !!(data?.manglik_present || (data?.manglik_status && data.manglik_status !== 'Non-Manglik'));
    return {
      present,
      status: data?.manglik_status || null,
      percentage: data?.percentage ?? null,
      description: data?.description || null,
      raw: data
    };
  }

  normalizePitra(data) {
    const present = !!(data?.present || data?.pitra_present);
    return {
      present,
      oneLine: data?.one_line || data?.oneLine || null,
      description: data?.description || null,
      raw: data
    };
  }

  normalizeSadeSati(data) {
    const rawStatus = data?.sadhesati_status || data?.sade_sati_status || data?.status;
    const status = rawStatus ? String(rawStatus) : '';
    const lower = status.toLowerCase();
    const present = !!(lower.includes('under') || lower.includes('ongoing') || lower.includes('running'));
    return {
      present,
      status,
      considerationDate: data?.consideration_date || null,
      isUndergoing: data?.is_undergoing ?? present,
      raw: data
    };
  }

  normalizeShani(data) {
    const present = !!(data?.shani_dosha_present || data?.present || data?.dosha_present);
    return {
      present,
      status: data?.status || data?.shani_status || null,
      description: data?.description || null,
      raw: data
    };
  }

  normalizeGandmool(data) {
    const present = !!(data?.gandmool_present || data?.present || data?.dosha_present);
    return {
      present,
      nakshatra: data?.nakshatra || null,
      description: data?.description || null,
      raw: data
    };
  }
}

const doshaService = new DoshaService();
export default doshaService;
