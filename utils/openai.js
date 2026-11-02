/**
 * OpenAI Utility Service
 * Handles OpenAI API interactions for chat completions
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import AppSettings from '../models/AppSettings.js';
import Client from '../models/Client.js';

dotenv.config();

// Legacy singleton client for env-based usage (voice, older flows)
let openaiClient = null;

const getOpenAIClient = () => {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured in environment variables');
    }
    openaiClient = new OpenAI({
      apiKey: apiKey
    });
  }
  return openaiClient;
};

// New: resolve OpenAI key from MongoDB (per-client or app-level), with env fallback
export const getOpenAIApiKey = async (clientId = null) => {
  if (clientId) {
    const isObjectId = mongoose.Types.ObjectId.isValid(clientId) && String(clientId).length === 24;
    const client = isObjectId
      ? await Client.findById(clientId).select('settings.openaiApiKey').lean()
      : await Client.findOne({ clientId: String(clientId) }).select('settings.openaiApiKey').lean();
    if (client?.settings?.openaiApiKey) return client.settings.openaiApiKey.trim();
  }

  const settings = await AppSettings.getSettings();
  if (settings?.openaiApiKey) return settings.openaiApiKey.trim();

  return process.env.OPENAI_API_KEY?.trim() || null;
};

/**
 * Get chat completion from OpenAI
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options (model, temperature, etc.)
 * @returns {Promise<Object>} OpenAI response
 */
export const getChatCompletion = async (messages, options = {}) => {
  try {
    const client = getOpenAIClient();
    
    const {
      model = process.env.OPENAI_MODEL || 'gpt-4o',
      temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
      max_tokens = parseInt(process.env.OPENAI_MAX_TOKENS || '1000'),
      ...otherOptions
    } = options;

    const response = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      ...otherOptions
    });

    return {
      success: true,
      content: response.choices[0]?.message?.content || '',
      usage: response.usage,
      model: response.model
    };
  } catch (error) {
    console.error('OpenAI API Error:', error);
    throw new Error(`OpenAI API error: ${error.message}`);
  }
};

/**
 * Get chat completion from OpenAI using API key resolved from MongoDB (per-client or app-level).
 * Does NOT use the global singleton client to allow per-client keys to change at runtime.
 */
export const getChatCompletionFromDb = async (messages, options = {}, clientId = null) => {
  try {
    const apiKey = await getOpenAIApiKey(clientId);
    if (!apiKey) {
      console.warn('OpenAI API key not configured in DB or env. Skipping completion.');
      return { success: false, content: '' };
    }

    const client = new OpenAI({ apiKey });

    const {
      model = process.env.OPENAI_MODEL || 'gpt-4o',
      temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
      max_tokens = parseInt(process.env.OPENAI_MAX_TOKENS || '1000'),
      ...otherOptions
    } = options;

    const response = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      ...otherOptions
    });

    return {
      success: true,
      content: response.choices[0]?.message?.content || '',
      usage: response.usage,
      model: response.model
    };
  } catch (error) {
    console.error('OpenAI API (DB key) Error:', error);
    return { success: false, content: '' };
  }
};

/**
 * Stream chat completion from OpenAI
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} options - Additional options
 * @returns {AsyncGenerator} Stream of response chunks
 */
export const streamChatCompletion = async function* (messages, options = {}) {
  try {
    const client = getOpenAIClient();
    
    const {
      model = process.env.OPENAI_MODEL || 'gpt-4o',
      temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.7'),
      max_tokens = parseInt(process.env.OPENAI_MAX_TOKENS || '1000'),
      ...otherOptions
    } = options;

    const stream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
      stream: true,
      ...otherOptions
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        yield content;
      }
    }
  } catch (error) {
    console.error('OpenAI Stream Error:', error);
    throw new Error(`OpenAI stream error: ${error.message}`);
  }
};

