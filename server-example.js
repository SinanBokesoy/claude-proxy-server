const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;

// Enhanced security middleware
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true,
    optionsSuccessStatus: 200
}));

// Security headers middleware
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    next();
});

// Rate limiting would go here (if needed)
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
        // Basic request validation
        if (req.headers['content-type'] !== 'application/json') {
            throw new Error('Invalid content type');
        }
    }
}));

// Environment validation
if (!process.env.CLAUDE_API_KEY) {
    console.error('Missing required environment variable: CLAUDE_API_KEY');
}

// Google Sheets setup
let sheets = null;
let auth = null;

async function initializeGoogleSheets() {
    try {
        if (!process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_CLIENT_EMAIL) {
            console.log('Google credentials not configured - using mock validation');
            return false;
        }

        // Clean up the private key (handle newlines and escape characters)
        const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
        
        auth = new google.auth.JWT(
            process.env.GOOGLE_CLIENT_EMAIL,
            null,
            privateKey,
            ['https://www.googleapis.com/auth/spreadsheets']
        );

        await auth.authorize();
        sheets = google.sheets({ version: 'v4', auth });
        
        console.log('✅ Google Sheets API initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Sheets:', error.message);
        return false;
    }
}

// Initialize Google Sheets on startup
initializeGoogleSheets();

// Health check endpoint
app.get('/health', (req, res) => {
    const status = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: {
            hasClaudeKey: !!process.env.CLAUDE_API_KEY,
            hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY,
            hasGoogleEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
            hasSpreadsheetId: !!process.env.GOOGLE_SPREADSHEET_ID,
            googleSheetsReady: !!sheets,
            port: PORT,
            nodeVersion: process.version,
            platform: process.platform
        }
    };
    res.json(status);
});

// Helper function to find user in Google Sheets
async function findUserInSheet(serialNumber) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        console.log(`Searching for serial number: ${serialNumber}`);
        
        // Get all data from the sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z', // Get all columns
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in spreadsheet');
            return null;
        }

        console.log(`Found ${rows.length} rows in spreadsheet`);
        
        // Find header row to identify columns
        const headers = rows[0];
        const serialColumnIndex = headers.findIndex(header => 
            header && header.toLowerCase().includes('serial')
        );
        const tokenColumnIndex = headers.findIndex(header => 
            header && header.toLowerCase().includes('token')
        );

        console.log(`Serial column index: ${serialColumnIndex}, Token column index: ${tokenColumnIndex}`);

        if (serialColumnIndex === -1 || tokenColumnIndex === -1) {
            throw new Error('Could not find Serial or Token columns in spreadsheet');
        }

        // Search for the serial number
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[serialColumnIndex] === serialNumber) {
                const tokens = parseInt(row[tokenColumnIndex]) || 0;
                console.log(`Found user: row ${i + 1}, tokens: ${tokens}`);
                return {
                    rowIndex: i + 1, // 1-based for Google Sheets API
                    serialColumnIndex: serialColumnIndex,
                    tokenColumnIndex: tokenColumnIndex,
                    currentTokens: tokens,
                    isValid: tokens > 0
                };
            }
        }

        console.log('Serial number not found in spreadsheet');
        return null;
    } catch (error) {
        console.error('Error searching Google Sheets:', error);
        throw error;
    }
}

// Helper function to update tokens in Google Sheets
async function updateTokensInSheet(rowIndex, columnIndex, newTokenValue) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        const columnLetter = String.fromCharCode(65 + columnIndex); // Convert 0->A, 1->B, etc.
        const range = `Sheet1!${columnLetter}${rowIndex}`;
        
        console.log(`Updating ${range} with value: ${newTokenValue}`);

        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: range,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[newTokenValue]]
            }
        });

        console.log('✅ Successfully updated Google Sheets');
        return true;
    } catch (error) {
        console.error('❌ Error updating Google Sheets:', error);
        throw error;
    }
}

// Request authentication middleware
function authenticateRequest(req, res, next) {
    const userAgent = req.headers['user-agent'];
    const contentType = req.headers['content-type'];
    
    // Basic client validation
    if (!userAgent || !userAgent.includes('SecureJUCEClient')) {
        console.log('⚠️ Unauthorized request - invalid user agent:', userAgent);
        return res.status(403).json({ error: 'Unauthorized client' });
    }
    
    if (contentType !== 'application/json') {
        console.log('⚠️ Unauthorized request - invalid content type:', contentType);
        return res.status(400).json({ error: 'Invalid content type' });
    }
    
    next();
}

// Claude API proxy endpoint - using curl like your working JUCE version
app.post('/api/claude', authenticateRequest, async (req, res) => {
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
                    output: responseData.usage?.output_tokens || 0,
                    cache_creation: responseData.usage?.cache_creation_input_tokens || 0,
                    cache_read: responseData.usage?.cache_read_input_tokens || 0
                };
                
                // Calculate total tokens consumed (matching your JUCE calculation)
                const totalTokensConsumed = tokenUsage.input + tokenUsage.output + 
                                          tokenUsage.cache_creation + tokenUsage.cache_read;
                
                console.log('Token usage:', tokenUsage);
                console.log('Total tokens consumed:', totalTokensConsumed);
                
                // Send response in format expected by your JUCE client
                const responsePayload = {
                    response: responseText,
                    model: model,
                    device_id: device_id,
                    status: 'success',
                    tokens: tokenUsage,
                    total_tokens_consumed: totalTokensConsumed,
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

// Google Sheets validation endpoint
app.post('/api/validate', authenticateRequest, async (req, res) => {
    console.log('Validation request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { serial_number, device_id } = req.body;
        
        if (!serial_number || !device_id) {
            return res.status(400).json({ error: 'Serial number and device ID are required' });
        }
        
        // Check if Google Sheets is available
        if (!sheets) {
            console.log('Google Sheets not available, using mock validation');
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
        
        try {
            // Real Google Sheets validation
            console.log('Performing real Google Sheets validation...');
            const userInfo = await findUserInSheet(serial_number);
            
            if (!userInfo) {
                return res.json({
                    valid: false,
                    error: 'Serial number not found',
                    serial_number: serial_number,
                    device_id: device_id,
                    tokens_remaining: 0,
                    source: 'google_sheets',
                    timestamp: new Date().toISOString()
                });
            }
            
            return res.json({
                valid: userInfo.isValid,
                serial_number: serial_number,
                device_id: device_id,
                tokens_remaining: userInfo.currentTokens,
                row_index: userInfo.rowIndex,
                source: 'google_sheets',
                timestamp: new Date().toISOString()
            });
            
        } catch (googleError) {
            console.error('Google Sheets validation error:', googleError);
            return res.status(500).json({
                error: 'Google Sheets validation failed',
                details: googleError.message,
                serial_number: serial_number,
                device_id: device_id,
                timestamp: new Date().toISOString()
            });
        }
        
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
app.post('/api/consume-tokens', authenticateRequest, async (req, res) => {
    console.log('Token consumption request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { serial_number, tokens_to_consume, device_id } = req.body;
        
        if (!serial_number || !device_id || typeof tokens_to_consume !== 'number') {
            return res.status(400).json({ error: 'Serial number, device ID, and tokens_to_consume (number) are required' });
        }
        
        if (tokens_to_consume <= 0) {
            return res.status(400).json({ error: 'tokens_to_consume must be positive' });
        }
        
        // Check if Google Sheets is available
        if (!sheets) {
            console.log('Google Sheets not available, using mock token consumption');
            const mockTokensRemaining = Math.max(0, 1000 - tokens_to_consume);
            return res.json({
                success: true,
                new_tokens: mockTokensRemaining,
                consumed: tokens_to_consume,
                serial_number: serial_number,
                device_id: device_id,
                source: 'mock',
                timestamp: new Date().toISOString()
            });
        }
        
        try {
            // Real Google Sheets token consumption
            console.log('Performing real Google Sheets token consumption...');
            const userInfo = await findUserInSheet(serial_number);
            
            if (!userInfo) {
                return res.status(404).json({
                    success: false,
                    error: 'Serial number not found',
                    serial_number: serial_number,
                    device_id: device_id,
                    timestamp: new Date().toISOString()
                });
            }
            
            if (userInfo.currentTokens < tokens_to_consume) {
                return res.status(400).json({
                    success: false,
                    error: 'Insufficient tokens',
                    current_tokens: userInfo.currentTokens,
                    requested: tokens_to_consume,
                    serial_number: serial_number,
                    device_id: device_id,
                    timestamp: new Date().toISOString()
                });
            }
            
            // Calculate new token value
            const newTokenValue = userInfo.currentTokens - tokens_to_consume;
            
            // Update Google Sheets
            await updateTokensInSheet(userInfo.rowIndex, userInfo.tokenColumnIndex, newTokenValue);
            
            console.log(`✅ Successfully consumed ${tokens_to_consume} tokens. New balance: ${newTokenValue}`);
            
            return res.json({
                success: true,
                new_tokens: newTokenValue,
                consumed: tokens_to_consume,
                previous_tokens: userInfo.currentTokens,
                serial_number: serial_number,
                device_id: device_id,
                source: 'google_sheets',
                timestamp: new Date().toISOString()
            });
            
        } catch (googleError) {
            console.error('Google Sheets token consumption error:', googleError);
            return res.status(500).json({
                success: false,
                error: 'Google Sheets token consumption failed',
                details: googleError.message,
                serial_number: serial_number,
                device_id: device_id,
                timestamp: new Date().toISOString()
            });
        }
        
    } catch (error) {
        console.error('Token consumption error:', error);
        res.status(500).json({ 
            success: false,
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
    console.log('- GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_SPREADSHEET_ID:', process.env.GOOGLE_SPREADSHEET_ID ? 'Present ✓' : 'Missing ✗');
    console.log('- Node.js version:', process.version);
    console.log('- Platform:', process.platform);
    console.log('\nServer ready to handle requests...');
});
