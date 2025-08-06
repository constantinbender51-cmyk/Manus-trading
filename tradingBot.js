const crypto = require('crypto');
const axios = require('axios');

// --- Configuration ---
// Replace with your actual API keys and secrets
// --- Configuration ---
// Load API keys from environment variables for security
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY;
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Add a check to ensure the bot doesn't start without its keys
if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET || !DEEPSEEK_API_KEY) {
    console.error('FATAL ERROR: One or more API keys are missing from environment variables.');
    process.exit(1); // Exit the process if keys are not found
}

const KRAKEN_BASE_URL = 'https://futures.kraken.com';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Trading parameters
const SYMBOL = 'pi_xbtusd'; // The trading pair, e.g., Bitcoin/USD perpetual future
const TRADE_INTERVAL_MS = 60000; // Run the trading loop every 60 seconds

/**
 * ====================================================================
 * KRAKEN FUTURES API CLIENT
 * ====================================================================
 * Handles fetching data and executing orders on Kraken Futures.
 */
class KrakenFuturesClient {
    constructor(apiKey, apiSecret, baseUrl) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = baseUrl;
        this.nonceCounter = 0;
    }

    /**
     * Generates a unique nonce for each request.
     */
    _createNonce() {
        if (this.nonceCounter > 9999) this.nonceCounter = 0;
        const timestamp = Date.now();
        return timestamp + ('0000' + this.nonceCounter++).slice(-5);
    }

    /**
     * Creates authentication headers for private API endpoints.
     */
    _getAuthHeaders(endpoint, postData = '') {
        const path = endpoint.startsWith('/derivatives') ? endpoint.slice('/derivatives'.length) : endpoint;
        const nonce = this._createNonce();
        const message = postData + nonce + path;

        const hash = crypto.createHash('sha256').update(message).digest();
        const secretDecoded = Buffer.from(this.apiSecret, 'base64');
        const hmac = crypto.createHmac('sha512', secretDecoded);
        const signature = hmac.update(hash).digest('base64');

        return {
            'APIKey': this.apiKey,
            'Nonce': nonce,
            'Authent': signature,
        };
    }

    /**
     * Fetches historical market data (candlesticks).
     * @param {string} symbol - The instrument symbol (e.g., 'pi_xbtusd').
     */
    async fetchMarketData(symbol) {
        const endpoint = '/derivatives/api/v3/history';
        const params = `symbol=${symbol}`;
        const url = `${this.baseUrl}${endpoint}?${params}`;
        console.log(`Fetching market data for ${symbol}...`);
        try {
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            console.error('Error fetching market data:', error.response ? error.response.data : error.message);
            throw error;
        }
    }

    /**
     * Sends an order to Kraken Futures.
     * @param {object} orderDetails - The details of the order.
     * @returns {Promise<object>} The API response.
     */
    async executeOrder(orderDetails) {
        const endpoint = '/derivatives/api/v3/sendorder';
        const url = this.baseUrl + endpoint;
        // Use URLSearchParams to correctly format the request body
        const postData = new URLSearchParams(orderDetails).toString();

        const headers = {
            ...this._getAuthHeaders(endpoint, postData),
            'Content-Type': 'application/x-www-form-urlencoded',
        };

        console.log('Executing order:', orderDetails);
        try {
            const response = await axios.post(url, postData, { headers });
            console.log('Order execution response:', response.data);
            return response.data;
        } catch (error) {
            console.error('Error executing order:', error.response ? error.response.data : error.message);
            throw error;
        }
    }
}

/**
 * ====================================================================
 * DEEPSEEK AI ANALYSIS CLIENT
 * ====================================================================
 * Sends data to the Deepseek API for analysis and recommendations.
 */
async function analyzeWithDeepseek(marketData) {
    console.log('Sending data to Deepseek for analysis...');

    // A sophisticated prompt is crucial for good results.
    // Provide context, rules, and the desired output format.
    const prompt = `
        You are a trading analysis AI. Your task is to analyze the provided market data and recommend a trading action.
        The data is for the ${SYMBOL} futures contract.

        Rules:
        1. Your response MUST be a JSON object.
        2. The JSON object must contain two keys: "action" and "reason".
        3. The "action" can be one of three values: "buy", "sell", or "hold".
        4. The "reason" should be a brief explanation for your decision.

        Example Response:
        {
            "action": "buy",
            "reason": "The price has broken above a key resistance level, and RSI indicates strong upward momentum."
        }

        Market Data (last 10 candles):
        ${JSON.stringify(marketData.candles.slice(-10), null, 2)}
    `;

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.5,
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            }
        });

        const content = response.data.choices[0].message.content;
        console.log('Deepseek raw response:', content);
        return JSON.parse(content); // Parse the JSON string into an object
    } catch (error) {
        console.error('Error calling Deepseek API:', error.response ? error.response.data : error.message);
        return { action: 'hold', reason: 'AI analysis failed.' }; // Fail-safe
    }
}

/**
 * ====================================================================
 * TRADING LOGIC
 * ====================================================================
 * The main loop that connects all the pieces.
 */
async function tradingLoop() {
    console.log('\n--- Starting New Trading Cycle ---');
    const krakenClient = new KrakenFuturesClient(KRAKEN_API_KEY, KRAKEN_API_SECRET, KRAKEN_BASE_URL);

    try {
        // 1. FETCH: Get the latest market data from Kraken
        const marketData = await krakenClient.fetchMarketData(SYMBOL);
        if (!marketData || !marketData.candles) {
            console.log('Could not fetch valid market data. Skipping cycle.');
            return;
        }

        // 2. ANALYZE: Send data to Deepseek for a recommendation
        const recommendation = await analyzeWithDeepseek(marketData);
        console.log(`AI Recommendation: ${recommendation.action.toUpperCase()}. Reason: ${recommendation.reason}`);

        // 3. PARSE & EXECUTE: Act on the AI's recommendation
        if (recommendation.action === 'buy' || recommendation.action === 'sell') {
            const order = {
                orderType: 'mkt', // Market order for simplicity
                symbol: SYMBOL,
                side: recommendation.action, // 'buy' or 'sell'
                size: 1, // Define your trade size
            };
            
            // Uncomment the line below to enable live trading
            // await krakenClient.executeOrder(order);

            console.log(`Action: Placed a ${order.side} order for ${order.size} contract(s) of ${order.symbol}.`);

        } else {
            console.log('Action: Holding position as per AI recommendation.');
        }

    } catch (error) {
        console.error('An error occurred during the trading cycle:', error.message);
    }
}

// --- Main Execution ---
console.log('Trading bot started. Press Ctrl+C to stop.');

// Run the trading loop immediately and then at the specified interval
tradingLoop();
setInterval(tradingLoop, TRADE_INTERVAL_MS);
