const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Custom HTTPS agent with specific configurations to match JUCE behavior
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000,
    // Disable certificate validation temporarily for testing
    rejectUnauthorized: false
});

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
            port: PORT,
            nodeVersion: process.version,
            platform: process.platform
        }
    };
    res.json(status);
});

// Claude API proxy endpoint - matching your working JUCE implementation
app.post('/api/claude', async (req, res) => {
    console.log('Claude API request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { message, model = 'claude-3-sonnet-20240229', device_id } = req.body;
        
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
        console.log('Using model:', model);
        console.log('Message length:', message.length);
        
        // Create the request payload exactly like your JUCE version
        const requestPayload = {
            model: model,
            max_tokens: 1000,
            messages: [
                {
                    role: 'user',
                    content: message
                }
            ]
        };
        
        console.log('Request payload:', JSON.stringify(requestPayload, null, 2));
        
        // Make the request with headers matching your JUCE implementation
        const response = await axios.post('https://api.anthropic.com/v1/messages', requestPayload, {
            headers: {
                'Authorization': `Bearer ${process.env.CLAUDE_API_KEY}`,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'User-Agent': 'Claude-Proxy-Server/1.0',
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive'
            },
            httpsAgent: httpsAgent,
            timeout: 30000,
            validateStatus: function (status) {
                return status >= 200 && status < 300;
            }
        });
        
        console.log('Claude API response status:', response.status);
        console.log('Claude API response headers:', response.headers);
        console.log('Claude API response data:', JSON.stringify(response.data, null, 2));
        
        // Extract the response content - matching your JUCE parsing
        let responseText = '';
        if (response.data && response.data.content && Array.isArray(response.data.content)) {
            responseText = response.data.content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join('');
        }
        
        if (!responseText) {
            responseText = 'No response content received';
        }
        
        console.log('Extracted response text length:', responseText.length);
        
        // Calculate token usage if available
        let tokenUsage = {
            input: response.data.usage?.input_tokens || 0,
            output: response.data.usage?.output_tokens || 0
        };
        
        console.log('Token usage:', tokenUsage);
        
        // Send response in format expected by your JUCE client
        const responsePayload = {
            response: responseText,
            model: model,
            device_id: device_id,
            status: 'success',
            tokens: tokenUsage,
            timestamp: new Date().toISOString()
        };
        
        res.json(responsePayload);
        
    } catch (error) {
        console.error('Claude API error details:');
        console.error('Error message:', error.message);
        console.error('Error code:', error.code);
        console.error('Status:', error.response?.status);
        console.error('Status Text:', error.response?.statusText);
        console.error('Response headers:', error.response?.headers);
        console.error('Response data:', error.response?.data);
        
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            if (error.response.status === 401) {
                res.status(500).json({ 
                    error: 'Authentication failed - invalid API key',
                    details: error.response.data,
                    status: error.response.status,
                    timestamp: new Date().toISOString()
                });
            } else if (error.response.status === 429) {
                res.status(429).json({ 
                    error: 'Rate limit exceeded',
                    details: error.response.data,
                    status: error.response.status,
                    timestamp: new Date().toISOString()
                });
            } else if (error.response.status === 400) {
                res.status(400).json({
                    error: 'Bad request - invalid parameters',
                    details: error.response.data,
                    status: error.response.status,
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(500).json({ 
                    error: 'Claude API request failed',
                    details: error.response.data || error.message,
                    status: error.response.status,
                    timestamp: new Date().toISOString()
                });
            }
        } else if (error.request) {
            // The request was made but no response was received
            console.error('No response received:', error.request);
            res.status(500).json({
                error: 'No response from Claude API',
                details: 'Network or timeout error',
                timestamp: new Date().toISOString()
            });
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('Request setup error:', error.message);
            res.status(500).json({
                error: 'Request configuration error',
                details: error.message,
                timestamp: new Date().toISOString()
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
            const isValid = serial_number.length > 5;
            return res.json({
                valid: isValid,
                serial_number: serial_number,
                device_id: device_id,
                tokens_remaining: isValid ? 1000 : 0,
                source: 'mock',
                timestamp: new Date().toISOString()
            });
        }
        
        // Real Google Sheets validation would go here
        console.log('Google Sheets validation not fully implemented yet');
        res.json({
            valid: false,
            error: 'Google Sheets validation not configured',
            serial_number: serial_number,
            device_id: device_id,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ 
            error: 'Validation failed',
            details: error.message,
            timestamp: new Date().toISOString()
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
            source: 'mock',
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Token consumption error:', error);
        res.status(500).json({ 
            error: 'Token consumption failed',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        details: error.message,
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_SPREADSHEET_ID:', process.env.GOOGLE_SPREADSHEET_ID ? 'Present ✓' : 'Missing ✗');
    console.log('- Node.js version:', process.version);
    console.log('- Platform:', process.platform);
    console.log('\nServer ready to handle requests...');
});
