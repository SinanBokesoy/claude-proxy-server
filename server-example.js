// server-example.js - Simple Node.js proxy server
// Run with: node server-example.js
// Install dependencies: npm install express axios google-auth-library

const express = require('express');
const axios = require('axios');
const { JWT } = require('google-auth-library');
const app = express();

app.use(express.json());

// Your API keys (set as environment variables)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

// Claude API proxy endpoint
app.post('/api/claude', async (req, res) => {
    try {
        const { message, model, device_id } = req.body;
        
        // Log request for monitoring
        console.log(`Claude request from device: ${device_id}`);
        
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{ role: 'user', content: message }]
        }, {
            headers: {
                'Authorization': `Bearer ${CLAUDE_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        res.json({
            response: response.data.content[0].text,
            tokens_used: response.data.usage.input_tokens + response.data.usage.output_tokens
        });
        
    } catch (error) {
        console.error('Claude API error:', error.message);
        res.status(500).json({ error: 'Claude API request failed' });
    }
});

// Google Sheets validation proxy
app.post('/api/validate', async (req, res) => {
    try {
        const { serial_number, device_id } = req.body;
        
        // Get Google Sheets access token
        const client = new JWT({
            email: GOOGLE_CLIENT_EMAIL,
            key: GOOGLE_PRIVATE_KEY,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        
        await client.authorize();
        const accessToken = client.gtoken.accessToken;
        
        // Query spreadsheet for serial number
        const sheetResponse = await axios.get(
            `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SPREADSHEET_ID}/values/Sheet1!A:Z`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );
        
        // Find serial number in data
        const rows = sheetResponse.data.values || [];
        const serialFound = rows.some(row => row.includes(serial_number));
        
        res.json({
            valid: serialFound,
            message: serialFound ? 'Serial number validated' : 'Invalid serial number'
        });
        
    } catch (error) {
        console.error('Validation error:', error.message);
        res.status(500).json({ error: 'Validation failed' });
    }
});

// Token consumption proxy
app.post('/api/consume-tokens', async (req, res) => {
    try {
        const { serial_number, tokens_to_consume, device_id } = req.body;
        
        // Similar Google Sheets logic to update token count
        // (Implementation would be similar to validation above)
        
        res.json({
            success: true,
            new_tokens: 9500, // Return updated token count
            consumed: tokens_to_consume
        });
        
    } catch (error) {
        console.error('Token consumption error:', error.message);
        res.status(500).json({ error: 'Token consumption failed' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log('Set these environment variables:');
    console.log('- CLAUDE_API_KEY');
    console.log('- GOOGLE_PRIVATE_KEY'); 
    console.log('- GOOGLE_CLIENT_EMAIL');
    console.log('- GOOGLE_SPREADSHEET_ID');
});