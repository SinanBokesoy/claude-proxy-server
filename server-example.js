const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Environment validation
if (!process.env.CLAUDE_API_KEY) {
    console.error('Missing required environment variable: CLAUDE_API_KEY');
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

// Claude API proxy endpoint - using curl like your working JUCE version
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
        
        console.log('Making request to Claude API using curl (matching JUCE implementation)...');
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
        
        const jsonString = JSON.stringify(requestPayload);
        console.log('Request payload:', jsonString);
        
        // Use curl command exactly like your working JUCE version
        const curlCommand = `curl -s -w "\\n%{http_code}" -X POST https://api.anthropic.com/v1/messages ` +
                           `--pinnedpubkey "sha256//vFoVs93Ln0mJL+OlkOg4+rUNLaBZ/lCPnOPlNkU2L7w=" ` +
                           `--ssl-reqd --tlsv1.2 ` +
                           `-H "Content-Type: application/json" ` +
                           `-H "x-api-key: ${process.env.CLAUDE_API_KEY}" ` +
                           `-H "anthropic-version: 2023-06-01" ` +
                           `-H "anthropic-beta: prompt-caching-2024-07-31" ` +
                           `-d '${jsonString.replace(/'/g, "'\\''")}'`;
        
        console.log('Executing curl command...');
        console.log('Command length:', curlCommand.length);
        
        // Execute curl command
        exec(curlCommand, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('Curl execution error:', error);
                console.error('Stderr:', stderr);
                return res.status(500).json({
                    error: 'Failed to execute curl command',
                    details: error.message,
                    stderr: stderr,
                    timestamp: new Date().toISOString()
                });
            }
            
            console.log('Curl stdout:', stdout);
            console.log('Curl stderr:', stderr);
            
            // Parse response (last line should be HTTP status code)
            const lines = stdout.trim().split('\n');
            const statusCode = parseInt(lines[lines.length - 1]);
            const responseBody = lines.slice(0, -1).join('\n');
            
            console.log('HTTP Status Code:', statusCode);
            console.log('Response body length:', responseBody.length);
            console.log('Response body:', responseBody.substring(0, 500) + '...');
            
            if (statusCode !== 200) {
                console.error('Non-200 status code:', statusCode);
                try {
                    const errorData = JSON.parse(responseBody);
                    return res.status(500).json({
                        error: 'Claude API request failed',
                        details: errorData,
                        status: statusCode,
                        timestamp: new Date().toISOString()
                    });
                } catch (parseError) {
                    return res.status(500).json({
                        error: 'Claude API request failed',
                        details: responseBody,
                        status: statusCode,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            
            try {
                // Parse the JSON response
                const responseData = JSON.parse(responseBody);
                console.log('Parsed response data:', JSON.stringify(responseData, null, 2));
                
                // Extract the response content - matching your JUCE parsing
                let responseText = '';
                if (responseData && responseData.content && Array.isArray(responseData.content)) {
                    responseText = responseData.content
                        .filter(item => item.type === 'text')
                        .map(item => item.text)
                        .join('');
                }
                
                if (!responseText) {
                    responseText = 'No response content received';
                }
                
                console.log('Extracted response text length:', responseText.length);
                console.log('Response text preview:', responseText.substring(0, 200) + '...');
                
                // Calculate token usage if available
                let tokenUsage = {
                    input: responseData.usage?.input_tokens || 0,
                    output: responseData.usage?.output_tokens || 0
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
                
            } catch (parseError) {
                console.error('JSON parse error:', parseError);
                console.error('Raw response body:', responseBody);
                res.status(500).json({
                    error: 'Failed to parse Claude API response',
                    details: parseError.message,
                    rawResponse: responseBody,
                    timestamp: new Date().toISOString()
                });
            }
        });
        
    } catch (error) {
        console.error('Request processing error:', error);
        res.status(500).json({
            error: 'Request processing failed',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Google Sheets validation endpoint (unchanged)
app.post('/api/validate', async (req, res) => {
    console.log('Validation request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { serial_number, device_id } = req.body;
        
        if (!serial_number || !device_id) {
            return res.status(400).json({ error: 'Serial number and device ID are required' });
        }
        
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
        
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ 
            error: 'Validation failed',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Token consumption endpoint (unchanged)
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
    console.log('Using curl-based implementation matching JUCE version');
    console.log('Environment check:');
    console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- Node.js version:', process.version);
    console.log('- Platform:', process.platform);
    console.log('\nServer ready to handle requests...');
});
