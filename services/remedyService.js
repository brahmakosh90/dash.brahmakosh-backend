// src/services/remedyService.js
// Fetches remedy suggestions (puja, gemstone, rudraksha) and caches in DB

import axios from 'axios';
import Remedy from '../models/Remedy.js';

const REMEDY_ENDPOINTS = {
  puja: '/puja_suggestion',
  gemstone: '/basic_gem_suggestion',
  rudraksha: '/rudraksha_suggestion',
  // Sade Sati specific remedies (API: /sadhesati_remedies)
  sadhesati: '/sadhesati_remedies'
};

class RemedyService {
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

  async fetchRemedy(name, birthData) {
    const endpoint = REMEDY_ENDPOINTS[name];
    if (!endpoint) return { error: `Unknown remedy: ${name}` };

    try {
      const response = await this.apiClient.post(endpoint, birthData);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`[Remedy Service] ${name} error:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        data: null
      };
    }
  }

  /**
   * Get remedies for a user (puja, gemstone, rudraksha, sadhesati)
   * Caches in DB; uses cache unless forceRefresh is true.
   */
  async getRemedies(user, options = {}) {
    const { forceRefresh = false } = options;
    const birthData = this.prepareBirthData(user);
    const userId = user?._id || user?.id;

    if (userId && !forceRefresh) {
      const existing = await Remedy.findOne({ userId }).lean();
      if (existing && existing.remedies && Object.keys(existing.remedies).length) {
        return {
          birthData: existing.birthData || birthData,
          remedies: existing.remedies
        };
      }
    }

    const [pujaRes, gemRes, rudraRes, sadhesatiRes] = await Promise.all([
      this.fetchRemedy('puja', birthData),
      this.fetchRemedy('gemstone', birthData),
      this.fetchRemedy('rudraksha', birthData),
      this.fetchRemedy('sadhesati', birthData)
    ]);

    const remedies = {
      puja: pujaRes.success ? pujaRes.data : { error: pujaRes.error },
      gemstone: gemRes.success ? gemRes.data : { error: gemRes.error },
      rudraksha: rudraRes.success ? rudraRes.data : { error: rudraRes.error },
      // Sade Sati (7.5 years Saturn phase) remedies
      sadhesati: sadhesatiRes.success ? sadhesatiRes.data : { error: sadhesatiRes.error }
    };

    if (userId) {
      await Remedy.findOneAndUpdate(
        { userId },
        {
          userId,
          birthData,
          remedies,
          lastFetched: new Date()
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    return {
      birthData,
      remedies
    };
  }
}

const remedyService = new RemedyService();
export default remedyService;

