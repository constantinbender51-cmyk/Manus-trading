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

// =====================================================================================
// SECTION 1: CONFIGURATION & TRADING PARAMETERS
// =====================================================================================

// --- API Credentials (Loaded from Environment Variables) ---
const KRAKEN_API_KEY = '2J/amVE61y0K0k34qVduE2fSiQTMpppw6Y+K+b+qt9zk7o+UvtBQTwBq';process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = '6CEQlIa0+YrlxBXWAfdvkpcCpVK3UT5Yidpg/o/36f60WWETLU1bU1jJwHK14LqFJq1T3FRj1Pdj/kk8zuhRiUJi';//process.env.KRAKEN_API_SECRET;
const DEEPSEEK_API_KEY = 'sk-ae85860567f8462b95e774393dfb5dc3';//process.env.DEEPSEEK_API_KEY;

// --- API Endpoints ---
const KRAKEN_FUTURES_BASE_URL = 'https://futures.kraken.com';
const KRAKEN_SPOT_BASE_URL = 'https://api.kraken.com';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// --- Master Control Switch ---
const IS_LIVE_TRADING_ENABLED = false; // IMPORTANT: Set to 'true' to allow real trades.

// --- Trading Strategy Parameters ---
const FUTURES_SYMBOL = 'pf_xbtusd';  // The instrument to trade (linear USD-margined BTC perpetual).
const SPOT_PAIR_SYMBOL = 'BTC/USD';   // The corresponding spot pair for fetching OHLC data.
const CANDLE_INTERVAL = 240;          // Timeframe for candles in minutes (e.g., 240 for 4-hour).
const TRADE_INTERVAL_MS = CANDLE_INTERVAL * 60 * 1000; // Bot execution frequency.

// --- Risk Management Parameters ---
const LEVERAGE = 10;                  // The leverage level set on your account (e.g., 10x).
const LEVERAGE_SAFETY_FACTOR = 0.9;   // Use only 90% of available leverage to avoid margin errors.
const RISK_PER_TRADE_PERCENT = 1.0;   // Max percentage of available margin to risk on a single trade.
const STOP_LOSS_PERCENT = 2.0;        // Percentage away from entry price to place the stop-loss.
const MINIMUM_TRADE_USD = 10;         // Minimum notional value (in USD) for a trade.

// =====================================================================================
// SECTION 2: KRAKEN API CLIENT FUNCTIONS
// =====================================================================================

let nonceCounter = 0;
/**
 * Generates a unique, increasing nonce for API requests.
 * @returns {string} A timestamp-based nonce.
 */
function createNonce() {
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

/**
 * Sends market and account data to the Deepseek AI for a trading recommendation.
 * @param {Array} candles - The raw candle data.
 * @param {object} indicators - The calculated technical indicators.
 * @param {object} accountContext - Information about the current account state.
 * @returns {Promise<object>} A promise that resolves to the AI's JSON recommendation.
 */
async function analyzeWithDeepseek(candles, indicators, accountContext) {
    console.log('Sending data to Deepseek AI for analysis...');
    const prompt = `
        You are a concise trading analysis AI for BTC/USD. Based on the data below, provide a recommendation.
        Rules:
        1. Your entire response MUST be a single, valid JSON object.
        2. The JSON must have two keys: "action" (string) and "reason" (string).
        3. "action" must be exactly "buy", "sell", or "hold".
        4. If a position is already open, your default recommendation is "hold".

        Current Account Context:
        - Has Open Position: ${accountContext.hasOpenPosition}
        - Available Margin (USD): ${accountContext.availableMargin?.toFixed(2)}

        Current Market Data:
        - Current Price: ${indicators.lastPrice?.toFixed(2)}
        - 14-period RSI: ${indicators.lastRSI?.toFixed(2)}
        - 50-period SMA: ${indicators.lastSMA50?.toFixed(2)}

        Recent 4-hour OHLC data:
        ${JSON.stringify(candles.slice(-10), null, 2)}
    `;

    const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        response_format: { type: "json_object" }
    }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });

    console.log(`AI Recommendation: ${response.data.choices[0].message.content}`);
    return JSON.parse(response.data.choices[0].message.content);
}

// =====================================================================================
// SECTION 4: MAIN TRADING LOGIC
// =====================================================================================

/**
 * The main operational loop of the trading bot.
 */
async function tradingLoop() {
    console.log(`\n--- Starting New Trading Cycle | ${new Date().toISOString()} ---`);
    try {
        // Fetch all required data in parallel for efficiency.
        //const [marketData, accountData, openPositions] = await Promise.all([
        //    fetchMarketData(),
        //    getAccountData(),
        //    getOpenPositions()
        //]);
        const marketData = await fetchMarketData();
        const accountData = await getAccountData();
        const openPositions = await getOpenPositions();
console.log(accountData);
console.log(openPositions);
        // Check if a position is already open for the target symbol.
        const position = openPositions?.openPositions?.find(p => p.symbol === FUTURES_SYMBOL);
        if (position) {
            console.log(`Action: Holding. A position for ${FUTURES_SYMBOL} is already open.`);
            return;
        }

        // Prepare data for AI analysis.
        const availableMargin = parseFloat(accountData.accounts.flex?.availableMargin || 0);
        const indicators = calculateIndicators(marketData.candles);
        const accountContext = { hasOpenPosition: false, availableMargin };

        // Get the trading recommendation from the AI.
        const recommendation = await analyzeWithDeepseek(marketData.candles, indicators, accountContext);

        // Act on the AI's recommendation.
        if (recommendation.action === 'buy' || recommendation.action === 'sell') {
            const currentPrice = indicators.lastPrice;

            // --- Calculate Trade Size based on Risk Management Parameters ---
            const maxLeveragedPositionUSD = availableMargin * LEVERAGE * LEVERAGE_SAFETY_FACTOR;
            const riskAmountUSD = availableMargin * (RISK_PER_TRADE_PERCENT / 100);
            const riskDefinedPositionUSD = riskAmountUSD / (STOP_LOSS_PERCENT / 100);
            let finalPositionUSD = Math.min(maxLeveragedPositionUSD, riskDefinedPositionUSD);

            // Enforce the minimum trade size.
            if (finalPositionUSD < MINIMUM_TRADE_USD) {
                console.log(`Calculated position $${finalPositionUSD.toFixed(2)} is below minimum. Bumping to $${MINIMUM_TRADE_USD}.`);
                finalPositionUSD = MINIMUM_TRADE_USD;
            }
            if (finalPositionUSD > maxLeveragedPositionUSD) {
                console.log(`Action: Holding. Minimum trade size of $${MINIMUM_TRADE_USD} exceeds max buying power.`);
                return;
            }

            // Convert the final USD position size to the BTC-denominated trade size.
            const tradeSizeBTC = finalPositionUSD / currentPrice;
            const roundedTradeSizeBTC = parseFloat(tradeSizeBTC.toFixed(4));

            if (roundedTradeSizeBTC <= 0) {
                console.log(`Action: Holding. Calculated BTC trade size is zero or negative.`);
                return;
            }

            // --- Execute Two-Step Trade: Entry + Stop-Loss ---
            // 1. Place the Market Order to enter the position.
            const entryOrder = {
                orderType: 'mkt',
                symbol: FUTURES_SYMBOL,
                side: recommendation.action,
                size: roundedTradeSizeBTC,
            };
            const entryResponse = await executeOrder(entryOrder);

            // 2. If entry was successful, place the protective Stop-Loss order.
            if (entryResponse && entryResponse.sendStatus.status === 'placed') {
                console.log("Entry order placed. Now placing protective stop-loss order.");
                const stopLossPrice = (recommendation.action === 'buy')
                    ? currentPrice * (1 - STOP_LOSS_PERCENT / 100)
                    : currentPrice * (1 + STOP_LOSS_PERCENT / 100);

                const roundedStopPrice = Math.round(stopLossPrice);
                const roundedLimitPrice = (recommendation.action === 'buy') ? roundedStopPrice - 1 : roundedStopPrice + 1;

                const stopLossOrder = {
                    orderType: 'stp',
                    symbol: FUTURES_SYMBOL,
                    side: (recommendation.action === 'buy') ? 'sell' : 'buy',
                    size: roundedTradeSizeBTC,
                    limitPrice: roundedLimitPrice,
                    stopPrice: roundedStopPrice,
                };
                await executeOrder(stopLossOrder);
            }
        } else {
            console.log('Action: Holding as per AI recommendation.');
        }
    } catch (error) {
        console.error('FATAL ERROR in trading loop:', error.message);
        // In a real production environment, you might want to add alerting here (e.g., email, Slack).
    }
}

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
