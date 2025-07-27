const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Environment validation
const requiredEnvVars = ['CLAUDE_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('Missing required environment variables:', missingVars);
    console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('CLAUDE')));
}

// Health check endpoint
app.get('/health', (req, res) => {
    const status = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: {
            hasClaudeKey: !!process.env.CLAUDE_API_KEY,
            hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY,
            port: PORT
        }
    };
    res.json(status);
});

// Claude API proxy endpoint
app.post('/api/claude', async (req, res) => {
    console.log('Claude API request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { message, model = 'claude-sonnet-4-20250514', device_id } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        if (!process.env.CLAUDE_API_KEY) {
            console.error('CLAUDE_API_KEY environment variable not set');
            return res.status(500).json({ error: 'Server configuration error: API key not configured' });
        }
        
        console.log('Making request to Claude API...');
        console.log('API Key present:', !!process.env.CLAUDE_API_KEY);
        console.log('API Key prefix:', process.env.CLAUDE_API_KEY ? process.env.CLAUDE_API_KEY.substring(0, 15) + '...' : 'undefined');
        
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: model,
            max_tokens: 1000,
            messages: [
                {
                    role: 'user',
                    content: message
                }
            ]
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.CLAUDE_API_KEY}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01'
            },
            timeout: 30000
        });
        
        console.log('Claude API response received successfully');
        
        // Extract the response content
        const responseText = response.data.content?.[0]?.text || 'No response content';
        
        res.json({
            response: responseText,
            model: model,
            device_id: device_id
        });
        
    } catch (error) {
        console.error('Claude API error details:');
        console.error('Status:', error.response?.status);
        console.error('Status Text:', error.response?.statusText);
        console.error('Headers:', error.response?.headers);
        console.error('Data:', error.response?.data);
        console.error('Full error:', error.message);
        
        if (error.response?.status === 401) {
            res.status(500).json({ 
                error: 'Authentication failed - invalid API key',
                details: error.response?.data
            });
        } else if (error.response?.status === 429) {
            res.status(429).json({ 
                error: 'Rate limit exceeded',
                details: error.response?.data
            });
        } else {
            res.status(500).json({ 
                error: 'Claude API request failed',
                details: error.message,
                status: error.response?.status
            });
        }
    }
});

// Google Sheets validation endpoint
app.post('/api/validate', async (req, res) => {
    console.log('Validation request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { serial_number, device_id } = req.body;
        
        if (!serial_number || !device_id) {
            return res.status(400).json({ error: 'Serial number and device ID are required' });
        }
        
        // Check if Google credentials are available
        if (!process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_CLIENT_EMAIL) {
            console.log('Google credentials not configured, using mock validation');
            // Mock validation for testing
            const isValid = serial_number.length > 5; // Simple validation
            return res.json({
                valid: isValid,
                serial_number: serial_number,
                device_id: device_id,
                tokens_remaining: isValid ? 1000 : 0,
                source: 'mock'
            });
        }
        
        // Real Google Sheets validation would go here
        console.log('Google Sheets validation not fully implemented yet');
        res.json({
            valid: false,
            error: 'Google Sheets validation not configured',
            serial_number: serial_number,
            device_id: device_id
        });
        
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ 
            error: 'Validation failed',
            details: error.message
        });
    }
});

// Token consumption endpoint
app.post('/api/consume-tokens', async (req, res) => {
    console.log('Token consumption request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { serial_number, tokens_to_consume, device_id } = req.body;
        
        if (!serial_number || !device_id || typeof tokens_to_consume !== 'number') {
            return res.status(400).json({ error: 'Serial number, device ID, and tokens_to_consume (number) are required' });
        }
        
        // Mock token consumption for testing
        const mockTokensRemaining = Math.max(0, 1000 - tokens_to_consume);
        
        res.json({
            success: true,
            new_tokens: mockTokensRemaining,
            consumed: tokens_to_consume,
            serial_number: serial_number,
            device_id: device_id,
            source: 'mock'
        });
        
    } catch (error) {
        console.error('Token consumption error:', error);
        res.status(500).json({ 
            error: 'Token consumption failed',
            details: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_SPREADSHEET_ID:', process.env.GOOGLE_SPREADSHEET_ID ? 'Present ✓' : 'Missing ✗');
    console.log('\nServer ready to handle requests...');
});