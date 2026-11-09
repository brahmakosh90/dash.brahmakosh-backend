// Side-effect module: import right after dotenv so the process fails fast, listing every bad variable.
import { assertEnv } from './validateEnv.js';

assertEnv();
