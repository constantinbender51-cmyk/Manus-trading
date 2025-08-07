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

const IS_LIVE_TRADING_ENABLED = true;
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
// SECTION 4: ACTION HANDLERS
// =====================================================================================

/**
 * Handles the logic for entering a new long or short position.
 * @param {object} plan - The strategic plan object from the AI.
 * @param {object} context - The full account and market context.
 * @returns {Promise<object>} A promise that resolves to the new notes object for this cycle.
 */
async function handleNewPosition(plan, context) {
    console.log(`--- Handling New Position: ${plan.action} ---`);

    // If a position already exists, do nothing. This is a safety check.
    if (context.hasOpenPosition) {
        console.log("Aborting entry: A position already exists.");
        return context.previousNotes; // Return original notes, no changes.
    }

    const currentPrice = context.indicators.lastPrice;

    // Calculate the trade size. This uses the helper function we already have.
    const tradeSizeBTC = calculateTradeSize(context.availableMargin, currentPrice);
    if (tradeSizeBTC <= 0) {
        console.log(`Action: Holding. Trade size calculation resulted in zero or less.`);
        return { ...context.previousNotes, generalObservations: "Trade size was zero, aborted entry." };
    }

    // --- Execute Two-Step Trade ---
    // 1. Place the ENTRY order.
    const entryOrder = {
        orderType: plan.orderType, // Use the order type from the AI plan ('mkt' or 'lmt')
        symbol: FUTURES_SYMBOL,
        side: plan.action === 'ENTER_LONG' ? 'buy' : 'sell',
        size: tradeSizeBTC,
        limitPrice: plan.orderType === 'lmt' ? plan.price : null // Add limit price if it's a limit order
    };
    const entryResponse = await executeOrder(entryOrder);

    // 2. If entry is successful, place the PROTECTIVE stop-loss.
    if (entryResponse && entryResponse.sendStatus.status === 'placed') {
        console.log("Entry order placed. Now placing protective stop-loss order.");
        const stopLossPrice = (plan.action === 'ENTER_LONG')
            ? currentPrice * (1 - STOP_LOSS_PERCENT / 100)
            : currentPrice * (1 + STOP_LOSS_PERCENT / 100);

        const roundedStopPrice = Math.round(stopLossPrice);
        const roundedLimitPrice = (plan.action === 'ENTER_LONG') ? roundedStopPrice - 1 : roundedStopPrice + 1;

        const stopLossOrder = {
            orderType: 'stp',
            symbol: FUTURES_SYMBOL,
            side: (plan.action === 'ENTER_LONG') ? 'sell' : 'buy',
            size: tradeSizeBTC,
            limitPrice: roundedLimitPrice,
            stopPrice: roundedStopPrice,
        };
        await executeOrder(stopLossOrder);

        // --- Create New Notes for a Successful Entry ---
        const newNotes = {
            lastTrade: {
                action: plan.action,
                result: "Open",
                reason: plan.reason,
                entryPrice: currentPrice,
                exitPrice: 0
            },
            generalObservations: `Successfully entered a ${plan.action} position.`
        };
        return newNotes;
    } else {
        // If the entry order failed, record it in the notes.
        console.log("Entry order failed to place.");
        return {
            ...context.previousNotes,
            generalObservations: `Attempted to ${plan.action} but the order failed.`
        };
    }
}
/**
 * Handles the logic for exiting the current open position.
 * @param {object} plan - The strategic plan object from the AI.
 * @param {object} context - The full account and market context.
 * @returns {Promise<object>} A promise that resolves to the new notes object for this cycle.
 */
async function handlePositionExit(plan, context) {
    console.log(`--- Handling Position Exit ---`);

    if (!context.hasOpenPosition) {
        console.log("Aborting exit: No position is currently open.");
        return context.previousNotes;
    }

    console.log("!!! EXIT LOGIC NOT YET IMPLEMENTED !!!");
    // TODO:
    // 1. Get the open stop-loss order ID from context.openOrders[0].order_id.
    // 2. Call a new `cancelOrder(orderId)` function.
    // 3. Place a market order opposite to the current position's side (context.position.side).
    // 4. Update notes with the result ("Closed") and exit price.

    return {
        ...context.previousNotes,
        generalObservations: "AI recommended an exit, but the logic is not yet implemented."
    };
}
/**
 * Handles the logic for adjusting the stop-loss of an existing position.
 * @param {object} plan - The strategic plan object from the AI.
 * @param {object} context - The full account and market context.
 * @returns {Promise<object>} A promise that resolves to the new notes object for this cycle.
 */
async function handleStopLossAdjustment(plan, context) {
    console.log(`--- Handling Stop-Loss Adjustment ---`);

    if (!context.hasOpenPosition || !context.openOrders || context.openOrders.length === 0) {
        console.log("Aborting SL adjustment: No position or open stop-loss order found.");
        return context.previousNotes;
    }

    console.log("!!! SL ADJUSTMENT LOGIC NOT YET IMPLEMENTED !!!");
    // TODO:
    // 1. Get the open stop-loss order ID from context.openOrders[0].order_id.
    // 2. Call a new `cancelOrder(orderId)` function.
    // 3. Place a NEW 'stp' order using the price from plan.price.
    // 4. Update notes to reflect the new stop-loss level.

    return {
        ...context.previousNotes,
        generalObservations: "AI recommended a SL adjustment, but the logic is not yet implemented."
    };
}
/**
 * Cancels a specific open order by its ID.
 * @param {string} orderId - The unique ID of the order to cancel.
 * @returns {Promise<object>} A promise that resolves to the API response.
 */
async function cancelOrder(orderId) {
    console.log(`Attempting to cancel order with ID: ${orderId}`);
    if (!IS_LIVE_TRADING_ENABLED) {
        console.log(`LIVE TRADING DISABLED. Cancel order for ${orderId} not sent.`);
        // Return a simulated success response for testing logic flow.
        return { cancelStatus: { status: 'cancelled' } };
    }

    const endpoint = '/derivatives/api/v3/cancelorder';
    const nonce = createNonce();
    
    // The data must be a form-urlencoded string.
    const data = `order_id=${orderId}`;
    
    const authent = signRequest(endpoint, nonce, data);
    const headers = {
        'Accept': 'application/json',
        'APIKey': KRAKEN_API_KEY,
        'Nonce': nonce,
        'Authent': authent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': data.length.toString()
    };

    try {
        const response = await axios.post(KRAKEN_FUTURES_BASE_URL + endpoint, data, { headers });
        console.log('Cancel order response:', response.data);
        return response.data;
    } catch (error) {
        console.error(`Failed to cancel order ${orderId}:`, error.response?.data || error.message);
        // Return a failure structure so the calling function knows it didn't work.
        return { cancelStatus: { status: 'failed', reason: error.response?.data || error.message } };
    }
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

        let newNotes = previousNotes; // Default to old notes
        switch (strategyPlan.action) {
            case "ENTER_LONG":
            case "ENTER_SHORT":
                newNotes = await handleNewPosition(strategyPlan, accountContext);
                break;

            case "ADJUST_SL":
                newNotes = await handleStopLossAdjustment(strategyPlan, accountContext);
                break;

            case "EXIT_POSITION":
                newNotes = await handlePositionExit(strategyPlan, accountContext);
                break;

            case "HOLD":
            default:
                console.log("Action: Holding as per AI recommendation.");
                newNotes = { ...previousNotes, generalObservations: `AI recommended HOLD.` };
                break;
        }

        // 6. Write the updated notes file for the next cycle.
        await writeNotes(newNotes);

    } catch (error) {
        console.error('FATAL ERROR in trading loop:', error.message);
        const errorNotes = { generalObservations: `The bot crashed with error: ${error.message}` };
        await writeNotes(errorNotes);
    }
}

// =====================================================================================
// SECTION 5: BOT INITIALIZATION
// =====================================================================================
/**
 * A temporary function to test the cancelOrder functionality with a specific ID.
 */
async function runCancelTest() {
    console.log("--- INITIATING CANCEL ORDER TEST ---");
    
    // The specific order ID you want to cancel.
    const orderIdToCancel = '9f947155-48dc-4ad0-9636-8fa234785a44';
    
    // IMPORTANT: Make sure live trading is enabled for this test.
    if (!IS_LIVE_TRADING_ENABLED) {
        console.error("TEST ABORTED: IS_LIVE_TRADING_ENABLED must be set to 'true' to run this test.");
        return;
    }

    const result = await cancelOrder(orderIdToCancel);

    if (result && result.cancelStatus.status === 'cancelled') {
        console.log("--- TEST SUCCESSFUL: Order was cancelled successfully. ---");
    } else {
        console.log("--- TEST FAILED: Could not cancel the order. Check logs for details. ---");
    }
}
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
    console.log(" Manus AI Trading Bot Initializing for a CANCEL TEST...");
    console.log(` Live Trading Enabled: ${IS_LIVE_TRADING_ENABLED}`);
    console.log("=====================================================");

    if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !DEEPSEEK_API_KEY) {
        console.error('FATAL: API key(s) are missing. Please check your environment variables.');
        process.exit(1);
    }

    // --- TEMPORARILY CHANGE THIS LINE ---
    // Instead of starting the main loop, we run our specific test.
    runCancelTest(); 
    // runBot(); // <-- Comment out the main loop for now.
}

// --- Start the Bot ---
main();








    
