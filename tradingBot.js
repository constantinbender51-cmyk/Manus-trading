/**
 * =====================================================================================
 * Manus AI Trading Bot - Kraken Futures
 * =====================================================================================
 *
 * Description:
 * This Node.js application is an automated trading bot that interacts with the
 * Kraken Futures API and the Deepseek AI API. It operates in a continuous loop,
 * performing the following actions at a set interval:
 *
 * 1.  **FETCH**: Gathers market data (OHLC candles), account balance, and open positions.
 * 2.  **ANALYZE**: Calculates technical indicators (RSI, SMA) and sends the combined
 *      market and account context to the Deepseek AI for a trading recommendation.
 * 3.  **EXECUTE**: Based on the AI's signal ('buy', 'sell', or 'hold'), it can:
 *      - Place a market order to enter a new position.
 *      - Immediately place a corresponding stop-loss order to protect the new position.
 *      - Do nothing if a position is already open or if the signal is 'hold'.
 *
 * Author:
 * Built in collaboration with Manus.
 *
 * --- Configuration Instructions ---
 * To run this bot, you must set the following environment variables in your
 * deployment environment (e.g., Railway.app):
 *
 * - KRAKEN_API_KEY: Your Kraken Futures API Key.
 * - KRAKEN_API_SECRET: Your Kraken Futures API Secret.
 * - DEEPSEEK_API_KEY: Your Deepseek API Key.
 *
 * The trading parameters below can be adjusted to change the bot's behavior.
 *
 * =====================================================================================
 */

// --- Core Dependencies ---
const crypto = require('crypto');
const axios = require('axios');
const { RSI, SMA } = require('technicalindicators');
const fs = require('fs').promises; // Use the promise-based version for async/await
const path = require('path'); // Helper for creating a reliable file path

// =====================================================================================
// SECTION 1: CONFIGURATION & TRADING PARAMETERS
// =====================================================================================

// --- API Credentials (Loaded from Environment Variables) ---
const KRAKEN_API_KEY = '2J/amVE61y0K0k34qVduE2fSiQTMpppw6Y+K+b+qt9zk7o+UvtBQTwBq';process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = '6CEQlIa0+YrlxBXWAfdvkpcCpVK3UT5Yidpg/o/36f60WWETLU1bU1jJwHK14LqFJq1T3FRj1Pdj/kk8zuhRiUJi';//process.env.KRAKEN_API_SECRET;
const DEEPSEEK_API_KEY = 'sk-ae85860567f8462b95e774393dfb5dc3';//process.env.DEEPSEEK_API_KEY;

const KRAKEN_FUTURES_BASE_URL = 'https://futures.kraken.com';
const KRAKEN_SPOT_BASE_URL = 'https://api.kraken.com';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

const IS_LIVE_TRADING_ENABLED = false;
const FUTURES_SYMBOL = 'pf_xbtusd';
const SPOT_PAIR_SYMBOL = 'XBT/USD';
const CANDLE_INTERVAL = 240;
const TRADE_INTERVAL_MS = CANDLE_INTERVAL * 60 * 1000;

const LEVERAGE = 10;
const LEVERAGE_SAFETY_FACTOR = 0.9;
const RISK_PER_TRADE_PERCENT = 1.0;
const STOP_LOSS_PERCENT = 2.0;
const MINIMUM_TRADE_USD = 10;

// =====================================================================================
// SECTION 2: KRAKEN API CLIENT FUNCTIONS
// =====================================================================================

let nonceCounter = 0;
function createNonce() {
    if (nonceCounter > 9999) nonceCounter = 0;
    return Date.now() + ('0000' + nonceCounter++).slice(-5);
}

function signRequest(endpoint, nonce, postData = '') {
    const path = endpoint.startsWith('/derivatives') ? endpoint.slice('/derivatives'.length) : endpoint;
    const message = postData + nonce + path;
    const hash = crypto.createHash('sha256').update(message).digest();
    const secretDecoded = Buffer.from(KRAKEN_API_SECRET, 'base64');
    const hmac = crypto.createHmac('sha512', secretDecoded);
    return hmac.update(hash).digest('base64');
}

async function fetchMarketData() {
    const url = `${KRAKEN_SPOT_BASE_URL}/0/public/OHLC?pair=${SPOT_PAIR_SYMBOL}&interval=${CANDLE_INTERVAL}`;
    const response = await axios.get(url);
    if (response.data.error && response.data.error.length > 0) throw new Error(`Market data error: ${response.data.error.join(', ')}`);
    const resultKey = Object.keys(response.data.result)[0];
    return { candles: response.data.result[resultKey] };
}

async function getAccountData() {
    const endpoint = '/derivatives/api/v3/accounts';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
    return response.data;
}

async function getOpenPositions() {
    const endpoint = '/derivatives/api/v3/openpositions';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
    return response.data;
}

async function getOpenOrders() {
    const endpoint = '/derivatives/api/v3/openorders';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
    return response.data;
}

async function executeOrder(orderDetails) {
    if (!IS_LIVE_TRADING_ENABLED) {
        console.log(`LIVE TRADING DISABLED. Order prepared: ${JSON.stringify(orderDetails)}`);
        return { sendStatus: { status: 'placed', order_id: 'simulated-order-id' } };
    }
    const endpoint = '/derivatives/api/v3/sendorder';
    const nonce = createNonce();
    let data = `orderType=${orderDetails.orderType}&symbol=${orderDetails.symbol}&side=${orderDetails.side}&size=${orderDetails.size}`;
    if (orderDetails.limitPrice) data += `&limitPrice=${orderDetails.limitPrice}`;
    if (orderDetails.stopPrice) data += `&stopPrice=${orderDetails.stopPrice}`;
    const authent = signRequest(endpoint, nonce, data);
    const headers = { 'Accept': 'application/json', 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length.toString() };
    const response = await axios.post(KRAKEN_FUTURES_BASE_URL + endpoint, data, { headers });
    return response.data;
}

// =====================================================================================
// SECTION 3: HELPER FUNCTIONS
// =====================================================================================

const NOTES_FILE_PATH = path.join(__dirname, 'bot_notes.json');

async function readNotes() {
    try {
        await fs.access(NOTES_FILE_PATH);
        const data = await fs.readFile(NOTES_FILE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { lastTrade: { action: "none", result: "N/A" }, generalObservations: "Bot initialized." };
    }
}

async function writeNotes(notes) {
    try {
        await fs.writeFile(NOTES_FILE_PATH, JSON.stringify(notes, null, 2), 'utf8');
    } catch (error) {
        console.error("Could not write to notes file.", error);
    }
}

function calculateIndicators(candles) {
    const closePrices = candles.map(c => parseFloat(c[4]));
    const rsi = RSI.calculate({ values: closePrices, period: 14 });
    const sma50 = SMA.calculate({ values: closePrices, period: 50 });
    return { lastRSI: rsi[rsi.length - 1], lastSMA50: sma50[sma50.length - 1], lastPrice: closePrices[closePrices.length - 1] };
}

async function analyzeWithDeepseek(candles, indicators, accountContext) {
    const prompt = `
        You are a sophisticated trading strategy AI for BTC/USD. Your task is to return a precise action plan as a JSON object.
        --- Possible Actions & Required Parameters ---
        1.  { "action": "HOLD", "reason": "..." }
        2.  { "action": "ENTER_LONG", "orderType": "mkt" | "lmt", "price": <price_for_lmt_order>, "reason": "..." }
        3.  { "action": "ENTER_SHORT", "orderType": "mkt" | "lmt", "price": <price_for_lmt_order>, "reason": "..." }
        4.  { "action": "EXIT_POSITION", "reason": "..." }
        5.  { "action": "ADJUST_SL", "price": <new_stop_loss_price>, "reason": "..." }
        --- Rules ---
        - Your entire response MUST be a single, valid JSON object.
        - If entering with a limit order ("lmt"), you MUST provide a "price". For market orders ("mkt"), "price" is not needed.
        - Only recommend "ADJUST_SL" or "EXIT_POSITION" if a position is already open.
        - Default to { "action": "HOLD" } if no clear action is warranted.
        --- Bot's Memory (Notes from last cycle) ---
        ${JSON.stringify(accountContext.previousNotes, null, 2)}
        --- Current Account & Position Context ---
        - Has Open Position: ${accountContext.hasOpenPosition}
        - Position Details: ${JSON.stringify(accountContext.position, null, 2)}
        - Open Orders (e.g., current stop-loss): ${JSON.stringify(accountContext.openOrders, null, 2)}
        - Available Margin (USD): ${accountContext.availableMargin?.toFixed(2)}
        --- Current Market Data ---
        - Current Price: ${indicators.lastPrice?.toFixed(2)}
        - 14-period RSI: ${indicators.lastRSI?.toFixed(2)}
        - 50-period SMA: ${indicators.lastSMA50?.toFixed(2)}
        - Recent 4-hour OHLC data: ${JSON.stringify(candles.slice(-10), null, 2)}
    `;
    const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        response_format: { type: "json_object" }
    }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
    return JSON.parse(response.data.choices[0].message.content);
}

// =====================================================================================
// SECTION 4: MAIN TRADING LOGIC
// =====================================================================================
async function tradingLoop() {
    console.log(`\n--- Starting New Strategic Trading Cycle | ${new Date().toISOString()} ---`);
    try {
        const previousNotes = await readNotes();
        const [marketData, accountData, openPositions, openOrders] = await Promise.all([
            fetchMarketData(), getAccountData(), getOpenPositions(), getOpenOrders()
        ]);

        const position = openPositions?.openPositions?.find(p => p.symbol === FUTURES_SYMBOL);
        const hasOpenPosition = !!position;
        const stopLossForPosition = openOrders?.openOrders?.find(o => o.symbol === FUTURES_SYMBOL && o.orderType === 'stp');
        const availableMargin = parseFloat(accountData.accounts.flex?.availableMargin || 0);
        const indicators = calculateIndicators(marketData.candles);
        
        const accountContext = { hasOpenPosition, position, openOrders: stopLossForPosition ? [stopLossForPosition] : [], availableMargin, previousNotes };

        const strategyPlan = await analyzeWithDeepseek(marketData.candles, indicators, accountContext);
        
        if (!strategyPlan || !strategyPlan.action) {
            console.log("Could not get a valid strategic plan from the AI. Holding.");
            const notes = { ...previousNotes, generalObservations: "AI failed to return a valid plan." };
            await writeNotes(notes);
            return;
        }

        console.log(`AI Action Plan: ${strategyPlan.action}. Reason: ${strategyPlan.reason}`);

        switch (strategyPlan.action) {
            case "ENTER_LONG":
            case "ENTER_SHORT":
                console.log("Action handler for new position not yet implemented.");
                break;
            case "ADJUST_SL":
                console.log("Action handler for SL adjustment not yet implemented.");
                break;
            case "EXIT_POSITION":
                console.log("Action handler for position exit not yet implemented.");
                break;
            case "HOLD":
            default:
                console.log("Action: Holding as per AI recommendation.");
                break;
        }

        const notes = { ...previousNotes, generalObservations: `AI recommended ${strategyPlan.action}.` };
        await writeNotes(notes);

    } catch (error) {
        console.error('FATAL ERROR in trading loop:', error.message);
        const errorNotes = { generalObservations: `The bot crashed with error: ${error.message}` };
        await writeNotes(errorNotes);
    }
}

// =====================================================================================
// SECTION 5: BOT INITIALIZATION
// =====================================================================================
async function runBot() {
    try {
        await tradingLoop();
    } catch (error) {
        console.error('A critical, unhandled error occurred in the main runBot function:', error.message);
    } finally {
        console.log(`--- Cycle complete. Next run scheduled in ${CANDLE_INTERVAL} minutes. ---`);
        setTimeout(runBot, TRADE_INTERVAL_MS);
    }
}

function main() {
    console.log("=====================================================");
    console.log(" Manus AI Trading Bot Initializing...");
    console.log(` Trading Symbol: ${FUTURES_SYMBOL}`);
    console.log(` Live Trading Enabled: ${IS_LIVE_TRADING_ENABLED}`);
    console.log("=====================================================");

    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !DEEPSEEK_API_KEY) {
        console.error('FATAL: API key(s) are missing. Please check your environment variables.');
        process.exit(1);
    }

    runBot();
}

// --- Start the Bot ---
main();

    if (nonceCounter > 9999) nonceCounter = 0;
    return Date.now() + ('0000' + nonceCounter++).slice(-5);
}

/**
 * Creates the required authentication signature for private Kraken Futures API endpoints.
 * @param {string} endpoint - The API endpoint path (e.g., '/derivatives/api/v3/accounts').
 * @param {string} nonce - The unique nonce for this request.
 * @param {string} postData - The URL-encoded string of POST data, if any.
 * @returns {string} The Base64-encoded HMAC-SHA512 signature.
 */
function signRequest(endpoint, nonce, postData = '') {
    const path = endpoint.startsWith('/derivatives') ? endpoint.slice('/derivatives'.length) : endpoint;
    const message = postData + nonce + path;
    const hash = crypto.createHash('sha256').update(message).digest();
    const secretDecoded = Buffer.from(KRAKEN_API_SECRET, 'base64');
    const hmac = crypto.createHmac('sha512', secretDecoded);
    return hmac.update(hash).digest('base64');
}

/**
 * Fetches historical OHLC (candlestick) data from the Kraken Spot API.
 * @returns {Promise<object>} A promise that resolves to the market data.
 */
async function fetchMarketData() {
    console.log(`Fetching ${CANDLE_INTERVAL}-minute OHLC data for ${SPOT_PAIR_SYMBOL}...`);
    const url = `${KRAKEN_SPOT_BASE_URL}/0/public/OHLC?pair=${SPOT_PAIR_SYMBOL}&interval=${CANDLE_INTERVAL}`;
    const response = await axios.get(url);
    if (response.data.error && response.data.error.length > 0) {
        throw new Error(`Market data fetch error: ${response.data.error.join(', ')}`);
    }
    const resultKey = Object.keys(response.data.result)[0];
    console.log(`Successfully fetched ${response.data.result[resultKey].length} candles.`);
    return { candles: response.data.result[resultKey] };
}

/**
 * Fetches account balance and margin information.
 * @returns {Promise<object>} A promise that resolves to the account data.
 */
async function getAccountData() {
    const endpoint = '/derivatives/api/v3/accounts';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
    console.log("Successfully fetched account data.");
    return response.data;
}

/**
 * Fetches a list of all currently open positions.
 * @returns {Promise<object>} A promise that resolves to the open positions data.
 */
async function getOpenPositions() {
    const endpoint = '/derivatives/api/v3/openpositions';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
    console.log("Successfully fetched open positions.");
    return response.data;
}

/**
 * Universal order execution function. Can place Market, Limit, and Stop orders.
 * @param {object} orderDetails - An object containing all necessary parameters for the order.
 * @returns {Promise<object>} A promise that resolves to the API response from the order placement.
 */
async function executeOrder(orderDetails) {
    if (!IS_LIVE_TRADING_ENABLED) {
        console.log(`LIVE TRADING DISABLED. Order prepared but not sent: ${JSON.stringify(orderDetails)}`);
        // Return a simulated success response for testing logic flow.
        return { sendStatus: { status: 'placed', order_id: 'simulated-order-id' } };
    }

    const endpoint = '/derivatives/api/v3/sendorder';
    const nonce = createNonce();

    // Build the data string from the provided order details.
    let data = `orderType=${orderDetails.orderType}&symbol=${orderDetails.symbol}&side=${orderDetails.side}&size=${orderDetails.size}`;
    if (orderDetails.limitPrice) data += `&limitPrice=${orderDetails.limitPrice}`;
    if (orderDetails.stopPrice) data += `&stopPrice=${orderDetails.stopPrice}`;

    const authent = signRequest(endpoint, nonce, data);
    const headers = {
        'Accept': 'application/json',
        'APIKey': KRAKEN_API_KEY,
        'Nonce': nonce,
        'Authent': authent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length.toString()
    };

    console.log(`Executing ${orderDetails.orderType.toUpperCase()} order with data: "${data}"`);
    const response = await axios.post(KRAKEN_FUTURES_BASE_URL + endpoint, data, { headers });
    console.log('Order execution response:', response.data);
    return response.data;
}
/**
 * Fetches a list of all currently open (unfilled) orders, such as a stop-loss.
 * @returns {Promise<object>} A promise that resolves to the open orders data.
 */
async function getOpenOrders() {
    const endpoint = '/derivatives/api/v3/openorders';
    const nonce = createNonce();
    const authent = signRequest(endpoint, nonce, '');
    const headers = { 'APIKey': KRAKEN_API_KEY, 'Nonce': nonce, 'Authent': authent, 'Content-Type': 'application/json' };
    
    try {
        const response = await axios.get(KRAKEN_FUTURES_BASE_URL + endpoint, { headers });
        console.log("Successfully fetched open orders.");
        return response.data;
    } catch (error) {
        // It's not a fatal error if this fails, so we log and return an empty object.
        console.error('Could not fetch open orders:', error.response?.data || error.message);
        return { openOrders: [] }; // Return a default empty structure on failure
    }
}
// =====================================================================================
// SECTION: HELPER FUNCTIONS
// =====================================================================================

const NOTES_FILE_PATH = path.join(__dirname, 'bot_notes.json');

/**
 * Reads the notes from the bot_notes.json file.
 * If the file doesn't exist, it returns a default notes object.
 * @returns {Promise<object>} A promise that resolves to the parsed notes object.
 */
async function readNotes() {
    try {
        await fs.access(NOTES_FILE_PATH); // Check if the file exists
        const data = await fs.readFile(NOTES_FILE_PATH, 'utf8');
        console.log("Successfully read notes from previous cycle.");
        return JSON.parse(data);
    } catch (error) {
        // If the file doesn't exist or is empty, create a default structure.
        console.log("Notes file not found. Starting with fresh notes.");
        return {
            lastTrade: {
                action: "none",
                result: "N/A",
                reason: "No trades yet.",
                entryPrice: 0,
                exitPrice: 0
            },
            generalObservations: "Bot initialized."
        };
    }
}

/**
 * Writes the given notes object to the bot_notes.json file.
 * @param {object} notes - The notes object to save.
 */
async function writeNotes(notes) {
    try {
        await fs.writeFile(NOTES_FILE_PATH, JSON.stringify(notes, null, 2), 'utf8');
        console.log("Successfully wrote notes for the next cycle.");
    } catch (error) {
        console.error("FATAL: Could not write to notes file.", error);
    }
}

/**
 * Calculates the appropriate trade size in BTC based on risk management parameters.
 * @param {number} availableMargin - The current available margin in USD.
 * @param {number} currentPrice - The current price of the asset.
 * @returns {number} The calculated trade size in BTC, rounded to 4 decimal places. Returns 0 if the trade is not viable.
 */
function calculateTradeSize(availableMargin, currentPrice) {
    console.log("--- Calculating Trade Size ---");

    // Step 1: Determine max position size based on leverage and risk.
    const maxLeveragedPositionUSD = availableMargin * LEVERAGE * LEVERAGE_SAFETY_FACTOR;
    const riskAmountUSD = availableMargin * (RISK_PER_TRADE_PERCENT / 100);
    const riskDefinedPositionUSD = riskAmountUSD / (STOP_LOSS_PERCENT / 100);

    // Step 2: Choose the smaller of the two to respect both leverage and risk limits.
    let finalPositionUSD = Math.min(maxLeveragedPositionUSD, riskDefinedPositionUSD);
    console.log(`Calculated Position Size (USD): $${finalPositionUSD.toFixed(2)}`);

    // Step 3: Enforce the minimum trade size.
    if (finalPositionUSD < MINIMUM_TRADE_USD) {
        console.log(`Calculated size is below minimum. Bumping up to $${MINIMUM_TRADE_USD}.`);
        finalPositionUSD = MINIMUM_TRADE_USD;
    }

    // Step 4: Final safety check against buying power.
    if (finalPositionUSD > maxLeveragedPositionUSD) {
        console.log(`Final position size of $${finalPositionUSD.toFixed(2)} exceeds max buying power of $${maxLeveragedPositionUSD.toFixed(2)}.`);
        return 0; // Return 0 to indicate no trade.
    }

    console.log(`Final Position Size (USD): $${finalPositionUSD.toFixed(2)}`);

    // Step 5: Convert USD position to BTC-denominated trade size.
    const tradeSizeBTC = finalPositionUSD / currentPrice;
    const roundedTradeSizeBTC = parseFloat(tradeSizeBTC.toFixed(4));

    console.log(`Final Trade Size (BTC): ${roundedTradeSizeBTC}`);
    return roundedTradeSizeBTC;
}
// =====================================================================================
// SECTION 3: DATA PROCESSING & AI ANALYSIS
// =====================================================================================

/**
 * Calculates technical indicators from the provided candle data.
 * @param {Array} candles - The array of OHLC candle data.
 * @returns {object} An object containing the latest indicator values.
 */
function calculateIndicators(candles) {
    const closePrices = candles.map(c => parseFloat(c[4]));
    const rsi = RSI.calculate({ values: closePrices, period: 14 });
    const sma50 = SMA.calculate({ values: closePrices, period: 50 });
    return {
        lastRSI: rsi[rsi.length - 1],
        lastSMA50: sma50[sma50.length - 1],
        lastPrice: closePrices[closePrices.length - 1]
    };
}

async function analyzeWithDeepseek(candles, indicators, accountContext) {
    console.log('Sending advanced context to Deepseek AI for strategic analysis...');

    const prompt = `
        You are a sophisticated trading strategy AI for BTC/USD. Your task is to return a precise action plan as a JSON object.

        --- Possible Actions & Required Parameters ---
        1.  { "action": "HOLD", "reason": "..." }
        2.  { "action": "ENTER_LONG", "orderType": "mkt" | "lmt", "price": <price_for_lmt_order>, "reason": "..." }
        3.  { "action": "ENTER_SHORT", "orderType": "mkt" | "lmt", "price": <price_for_lmt_order>, "reason": "..." }
        4.  { "action": "EXIT_POSITION", "reason": "..." } // To close the current position
        5.  { "action": "ADJUST_SL", "price": <new_stop_loss_price>, "reason": "..." } // To move the stop-loss

        --- Rules ---
        - Your entire response MUST be a single, valid JSON object matching one of the schemas above.
        - If entering with a limit order ("lmt"), you MUST provide a "price". For market orders ("mkt"), "price" is not needed.
        - You can only recommend "ADJUST_SL" or "EXIT_POSITION" if a position is already open.
        - If no clear action is warranted, default to { "action": "HOLD" }.

        --- Bot's Memory (Notes from last cycle) ---
        ${JSON.stringify(accountContext.previousNotes, null, 2)}

        --- Current Account & Position Context ---
        - Has Open Position: ${accountContext.hasOpenPosition}
        - Position Details: ${JSON.stringify(accountContext.position, null, 2)}
        - Open Orders (e.g., current stop-loss): ${JSON.stringify(accountContext.openOrders, null, 2)}
        - Available Margin (USD): ${accountContext.availableMargin?.toFixed(2)}

        --- Current Market Data ---
        - Current Price: ${indicators.lastPrice?.toFixed(2)}
        - 14-period RSI: ${indicators.lastRSI?.toFixed(2)}
        - 50-period SMA: ${indicators.lastSMA50?.toFixed(2)}
        - Recent 4-hour OHLC data: ${JSON.stringify(candles.slice(-10), null, 2)}
  `;

    // Inside the analyzeWithDeepseek function...

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.5,
            response_format: { type: "json_object" }
        }, { 
            headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
            // --- THIS IS THE CRITICAL ADDITION ---
            // Set a specific timeout for the request (e.g., 30 seconds).
            // This prevents the connection from hanging indefinitely and tells
            // our code to handle the error, rather than letting the platform kill the process.
            timeout: 30000 // 30 seconds in milliseconds
        });

        console.log(`AI Recommendation: ${response.data.choices[0].message.content}`);
        return JSON.parse(response.data.choices[0].message.content);

    } catch (error) {
        // Add more specific logging for different error types
        if (error.code === 'ECONNABORTED') {
            console.error('Error: Deepseek API call timed out after 30 seconds.');
        } else if (error.response) {
            console.error('Error from Deepseek API:', error.response.status, error.response.data);
        } else {
            console.error('Error calling Deepseek API:', error.message);
        }
        // Return a safe default action if the AI fails
        return { action: 'hold', reason: 'AI analysis failed or timed out.' };
    }
}

// =====================================================================================
// =====================================================================================
// SECTION 4: MAIN TRADING LOGIC
// =====================================================================================
async function tradingLoop() {
    console.log(`\n--- Starting New Strategic Trading Cycle | ${new Date().toISOString()} ---`);
    try {
        // 1. Read notes from the previous cycle to provide memory.
        const previousNotes = await readNotes();

        // 2. Fetch all required data in parallel.
        const [marketData, accountData, openPositions, openOrders] = await Promise.all([
            fetchMarketData(),
            getAccountData(),
            getOpenPositions(),
            getOpenOrders()
        ]);

        // 3. Consolidate all context for the AI.
        const position = openPositions?.openPositions?.find(p => p.symbol === FUTURES_SYMBOL);
        // ... (the rest of the context building is the same) ...
        const accountContext = {
            hasOpenPosition,
            position,
            openOrders: stopLossForPosition ? [stopLossForPosition] : [],
            availableMargin,
            previousNotes
        };

        // =================================================================
        // THIS IS THE CORRECTED SECTION
        // =================================================================

        // 4. Get the strategic action plan from the AI.
        const strategyPlan = await analyzeWithDeepseek(marketData.candles, indicators, accountContext);
        
        // A safety check to ensure the AI returned a valid plan.
        if (!strategyPlan || !strategyPlan.action) {
            console.log("Could not get a valid strategic plan from the AI. Holding.");
            // We should still write notes to record this failure.
            const notes = { ...previousNotes, generalObservations: "AI failed to return a valid plan." };
            await writeNotes(notes);
            return;
        }

        console.log(`AI Action Plan: ${strategyPlan.action}. Reason: ${strategyPlan.reason}`);

        // 5. Use a switch statement to dispatch the action based on the defined plan.
        switch (strategyPlan.action) {
            case "ENTER_LONG":
            case "ENTER_SHORT":
                // We will build this function next.
                // await handleNewPosition(strategyPlan, accountContext);
                console.log("Action handler for new position not yet implemented.");
                break;

            case "ADJUST_SL":
                // We will build this function next.
                // await handleStopLossAdjustment(strategyPlan, accountContext);
                console.log("Action handler for SL adjustment not yet implemented.");
                break;

            case "EXIT_POSITION":
                // We will build this function next.
                // await handlePositionExit(strategyPlan, accountContext);
                console.log("Action handler for position exit not yet implemented.");
                break;

// =====================================================================================
// SECTION 4: MAIN TRADING LOGIC (Syntactically Corrected)
// =====================================================================================
async function tradingLoop() {
    console.log(`\n--- Starting New Strategic Trading Cycle | ${new Date().toISOString()} ---`);
    try {
        // 1. Read notes from the previous cycle.
        const previousNotes = await readNotes();

        // 2. Fetch all required data in parallel.
        const [marketData, accountData, openPositions, openOrders] = await Promise.all([
            fetchMarketData(),
            getAccountData(),
            getOpenPositions(),
            getOpenOrders()
        ]);

        // 3. Consolidate all context for the AI.
        const position = openPositions?.openPositions?.find(p => p.symbol === FUTURES_SYMBOL);
        const hasOpenPosition = !!position;
        const stopLossForPosition = openOrders?.openOrders?.find(o => o.symbol === FUTURES_SYMBOL && o.orderType === 'stp');
        const availableMargin = parseFloat(accountData.accounts.flex?.availableMargin || 0);
        const indicators = calculateIndicators(marketData.candles);
        
        const accountContext = {
            hasOpenPosition,
            position,
            openOrders: stopLossForPosition ? [stopLossForPosition] : [],
            availableMargin,
            previousNotes
        };

        // 4. Get the strategic action plan from the AI.
        const strategyPlan = await analyzeWithDeepseek(marketData.candles, indicators, accountContext);
        
        // Safety check for a valid plan from the AI.
        if (!strategyPlan || !strategyPlan.action) {
            console.log("Could not get a valid strategic plan from the AI. Holding.");
            const notes = { ...previousNotes, generalObservations: "AI failed to return a valid plan." };
            await writeNotes(notes);
            return;
        }

        console.log(`AI Action Plan: ${strategyPlan.action}. Reason: ${strategyPlan.reason}`);

        // 5. Use a switch statement to dispatch the action.
        switch (strategyPlan.action) {
            case "ENTER_LONG":
            case "ENTER_SHORT":
                // Placeholder for the handler function
                console.log("Action handler for new position not yet implemented.");
                break;

            case "ADJUST_SL":
                // Placeholder for the handler function
                console.log("Action handler for SL adjustment not yet implemented.");
                break;

            case "EXIT_POSITION":
                // Placeholder for the handler function
                console.log("Action handler for position exit not yet implemented.");
                break;

            case "HOLD":
            default:
                console.log("Action: Holding as per AI recommendation.");
                break;
        }

        // 6. Update and write notes for the next cycle.
        // This logic will eventually be moved into the individual handler functions.
        const notes = { ...previousNotes, generalObservations: `AI recommended ${strategyPlan.action}.` };
        await writeNotes(notes);

    } catch (error) {
        console.error('FATAL ERROR in trading loop:', error.message);
        // We should still try to write a note about the error.
        const errorNotes = { generalObservations: `The bot crashed with error: ${error.message}` };
        await writeNotes(errorNotes);
    }
} // <-- This closing bracket for the try...catch is crucial.


// =====================================================================================
// SECTION 5: BOT INITIALIZATION (Robust Loop)
// =====================================================================================

/**
 * The main operational loop of the trading bot.
 * This version uses a robust, self-correcting loop with setTimeout.
 */
async function runBot() {
    try {
        // Execute one full trading cycle.
        await tradingLoop();
    } catch (error) {
        // This catch block is a final safety net, though the one inside
        // tradingLoop should handle most operational errors.
        console.error('A critical, unhandled error occurred in the main runBot function:', error.message);
    } finally {
        // IMPORTANT: Whether the loop succeeded or failed, schedule the next run.
        // This ensures the bot is resilient and will try again after a failure.
        console.log(`--- Cycle complete. Next run scheduled in ${CANDLE_INTERVAL} minutes. ---`);
        setTimeout(runBot, TRADE_INTERVAL_MS);
    }
}

/**
 * Main function to initialize and start the bot.
 */
function main() {
    console.log("=====================================================");
    console.log(" Manus AI Trading Bot Initializing...");
    console.log(` Trading Symbol: ${FUTURES_SYMBOL}`);
    console.log(` Live Trading Enabled: ${IS_LIVE_TRADING_ENABLED}`);
    console.log("=====================================================");

    // Validate that all required API keys are present.
    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !DEEPSEEK_API_KEY) {
        console.error('FATAL: API key(s) are missing. Please check your environment variables.');
        process.exit(1); // Exit the process if configuration is incomplete.
    }

    // Start the robust, self-correcting loop.
    runBot();
}

// --- Start the Bot ---
main();
