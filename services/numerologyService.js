// src/services/numerologyService.js

import axios from 'axios';
import Numerology from '../models/Numerology.js';
import NumerologyUserProfile from '../models/NumerologyUserProfile.js';

class NumerologyService {
  constructor() {
    this.baseUrl = process.env.ASTROLOGY_API_BASE_URL || 'https://json.astrologyapi.com/v1';
    this.apiUserId = process.env.ASTROLOGY_API_USER_ID;
    this.apiKey = process.env.ASTROLOGY_API_KEY;
    
    // Create axios instance with authentication
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-astrologyapi-key': this.apiKey
      },
      timeout: 30000
    });
  }

  /**
   * Retry helper for AWS/first-hit warmup - some APIs need an initial request
   */
  async withRetry(fn, retries = 2) {
    try {
      return await fn();
    } catch (err) {
      if (retries > 0 && (err.message?.includes('first') || err.code === 'ECONNREFUSED' || err.response?.status >= 500)) {
        console.log('[Numerology Service] Retrying after initial failure...');
        await new Promise(r => setTimeout(r, 1500));
        return this.withRetry(fn, retries - 1);
      }
      throw err;
    }
  }

  /**
   * Format date components from Date object or user profile
   */
  extractDateComponents(dateInput) {
    let date;
    
    if (typeof dateInput === 'string' || dateInput instanceof Date) {
      date = new Date(dateInput);
    } else if (typeof dateInput === 'object' && dateInput.day && dateInput.month && dateInput.year) {
      return {
        day: parseInt(dateInput.day),
        month: parseInt(dateInput.month),
        year: parseInt(dateInput.year)
      };
    } else {
      throw new Error('Invalid date format');
    }

    return {
      day: date.getDate(),
      month: date.getMonth() + 1,
      year: date.getFullYear()
    };
  }

  /**
   * Call the numerology API endpoints (with retry for AWS first-hit)
   */
  async callNumeroAPI(endpoint, day, month, year, name) {
    const formData = new URLSearchParams();
    formData.append('day', day.toString());
    formData.append('month', month.toString());
    formData.append('year', year.toString());
    formData.append('name', name);

    console.log(`[Numerology Service] Calling ${endpoint} with params:`, { day, month, year, name });

    try {
      return await this.withRetry(async () => {
        const response = await this.axiosInstance.post(endpoint, formData);
        console.log(`[Numerology Service] ${endpoint} API response received`);
        return response.data;
      });
    } catch (error) {
      console.error(`[Numerology Service] Error calling ${endpoint}:`, error.message);
      const msg = error.response?.data?.message || error.message;
      throw new Error(`Failed to fetch ${endpoint}: ${msg}`);
    }
  }

  /**
   * Get or create numeroReport + numeroTable (static - based on name + DOB, fetch ONCE per user)
   * Returns null if userDob not provided
   */
  async getNumerologyStaticData(userId, userName, userDob, forceRefresh = false) {
    if (!userDob) return null;

    const { day, month, year } = this.extractDateComponents(userDob);

    if (!forceRefresh) {
      const existing = await NumerologyUserProfile.findOne({ userId }).lean();
      if (existing && existing.numeroReport && existing.numeroTable) {
        console.log('[Numerology Service] Returning cached numeroReport + numeroTable for user:', userId);
        return { source: 'database', data: existing };
      }
    }

    console.log('[Numerology Service] Fetching numeroReport + numeroTable (once per user)...');
    const [numeroReport, numeroTable] = await Promise.all([
      this.callNumeroAPI('/numero_report', day, month, year, userName),
      this.callNumeroAPI('/numero_table', day, month, year, userName)
    ]);

    const profile = await NumerologyUserProfile.findOneAndUpdate(
      { userId },
      { userId, name: userName, day, month, year, numeroReport, numeroTable, lastUpdated: new Date() },
      { upsert: true, new: true }
    ).lean();

    return { source: 'api', data: profile };
  }

  /**
   * Get daily prediction only (changes daily - cached per user per prediction date)
   * API is called with user DOB (day, month, year) + name; result is cached by prediction date (dateInput).
   * Returns { missingFields, message } when name or userDob is missing.
   */
  async getDailyPredictionOnly(userId, dateInput, userName, userDob, forceRefresh = false) {
    const trimmedName = (userName || '').toString().trim();
    if (!trimmedName) {
      return {
        source: 'missing',
        data: {
          missingFields: ['name'],
          message: 'Name is required for personalized daily numerology prediction'
        }
      };
    }

    if (!userDob || isNaN(new Date(userDob).getTime())) {
      return {
        source: 'missing',
        data: {
          missingFields: ['dateOfBirth'],
          message: 'Date of birth is required for personalized daily numerology prediction'
        }
      };
    }

    // Cache key: prediction date (e.g. today) so we store "prediction for this day"
    const { day: pdDay, month: pdMonth, year: pdYear } = this.extractDateComponents(dateInput);
    const normalizedDate = new Date(Date.UTC(pdYear, pdMonth - 1, pdDay, 0, 0, 0, 0));

    if (!forceRefresh) {
      const existing = await Numerology.findOne({ userId, day: pdDay, month: pdMonth, year: pdYear }).lean();
      if (existing?.dailyPrediction) {
        return { source: 'database', data: existing.dailyPrediction };
      }
    }

    // API call: send DOB (day, month, year) + name, not prediction date
    const { day: dobDay, month: dobMonth, year: dobYear } = this.extractDateComponents(userDob);
    console.log('[Numerology Service] Fetching daily prediction with DOB:', `${dobYear}-${dobMonth}-${dobDay}`);
    const dailyPrediction = await this.callNumeroAPI('/numero_prediction/daily', dobDay, dobMonth, dobYear, trimmedName);

    await Numerology.findOneAndUpdate(
      { userId, day: pdDay, month: pdMonth, year: pdYear },
      { userId, date: normalizedDate, day: pdDay, month: pdMonth, year: pdYear, name: userName, dailyPrediction },
      { upsert: true, new: true }
    );

    return { source: 'api', data: dailyPrediction };
  }

  /**
   * Get full numerology data: static (report+table) once + daily prediction for date
   */
  async getNumerologyData(userId, dateInput, userName, userDob, forceRefresh = false) {
    try {
      const { day, month, year } = this.extractDateComponents(dateInput);
      console.log(`[Numerology Service] Getting numerology for user ${userId} on ${year}-${month}-${day}`);

      // 1. Get static data (numeroReport, numeroTable) - uses user DOB, fetched once. Skip if no DOB.
      let staticResult = null;
      if (userDob) {
        staticResult = await this.getNumerologyStaticData(userId, userName, userDob, forceRefresh);
      }

      // 2. Get daily prediction - API called with DOB + name; cached per prediction date (dateInput)
      const dailyResult = await this.getDailyPredictionOnly(userId, dateInput, userName, userDob, forceRefresh);

      const combined = staticResult?.data
        ? { ...staticResult.data, dailyPrediction: dailyResult.data }
        : { numeroReport: null, numeroTable: null, dailyPrediction: dailyResult.data };

      return {
        source: (staticResult?.source === 'api') || dailyResult.source === 'api' ? 'api' : 'database',
        data: combined
      };
    } catch (error) {
      console.error('[Numerology Service] Error in getNumerologyData:', error);
      throw error;
    }
  }

  /**
   * Force refresh numerology data from API
   */
  async refreshNumerologyData(userId, dateInput, userName, userDob = null) {
    console.log('[Numerology Service] Force refreshing numerology data...');
    return this.getNumerologyData(userId, dateInput, userName, userDob || dateInput, true);
  }

  /**
   * Get numerology history for a user
   */
  async getNumerologyHistory(userId, limit = 10, skip = 0) {
    try {
      const history = await Numerology.find({ userId })
        .sort({ date: -1 })
        .limit(limit)
        .skip(skip)
        .lean();

      const total = await Numerology.countDocuments({ userId });

      return {
        history,
        total,
        limit,
        skip,
        hasMore: total > skip + limit
      };
    } catch (error) {
      console.error('[Numerology Service] Error fetching numerology history:', error);
      throw error;
    }
  }

  /**
   * Delete numerology data for a specific date
   */
  async deleteNumerologyData(userId, dateInput) {
    try {
      const { day, month, year } = this.extractDateComponents(dateInput);

      const result = await Numerology.findOneAndDelete({
        userId,
        day,
        month,
        year
      });

      if (!result) {
        throw new Error('Numerology data not found for this date');
      }

      console.log(`[Numerology Service] Deleted numerology data for user ${userId} on ${year}-${month}-${day}`);
      return result;
    } catch (error) {
      console.error('[Numerology Service] Error deleting numerology data:', error);
      throw error;
    }
  }
}

const numerologyService = new NumerologyService();
export default numerologyService;