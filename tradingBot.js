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
const SPOT_PAIR_SYMBOL = 'BTC/USD';
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








    
