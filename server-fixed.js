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

app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf, encoding) => {
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
        
        console.log('Initializing Google Sheets with:');
        console.log('- Email:', process.env.GOOGLE_CLIENT_EMAIL);
        console.log('- Private key length:', privateKey.length);
        console.log('- Spreadsheet ID:', process.env.GOOGLE_SPREADSHEET_ID);
        
        // FIXED: Use object format for JWT constructor
        auth = new google.auth.JWT({
            email: process.env.GOOGLE_CLIENT_EMAIL,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        console.log('Attempting to authorize...');
        await auth.authorize();
        console.log('✅ Authorization successful');
        
        sheets = google.sheets({ version: 'v4', auth });
        
        // Test the connection
        console.log('Testing spreadsheet access...');
        const testResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A1:A1',
        });
        
        console.log('✅ Google Sheets API initialized successfully');
        console.log('✅ Spreadsheet access confirmed');
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Sheets:', error.message);
        console.error('Full error:', error);
        return false;
    }
}

// Initialize Google Sheets on startup
initializeGoogleSheets();

// JSON validation and repair functions
function isValidJson(str) {
    try {
        JSON.parse(str);
        return true;
    } catch (error) {
        return false;
    }
}

function extractJsonFromResponse(text) {
    // Remove markdown code blocks
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*$/g, '');
    
    // Find first { and attempt to find matching }
    const startIndex = cleaned.indexOf('{');
    if (startIndex === -1) return null;
    
    // Try to find the complete JSON by counting braces
    let braceCount = 0;
    let endIndex = -1;
    
    for (let i = startIndex; i < cleaned.length; i++) {
        if (cleaned[i] === '{') {
            braceCount++;
        } else if (cleaned[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                endIndex = i;
                break;
            }
        }
    }
    
    if (endIndex !== -1) {
        return cleaned.substring(startIndex, endIndex + 1);
    }
    
    return null;
}

function repairTruncatedJson(jsonStr) {
    if (!jsonStr || !jsonStr.startsWith('{')) {
        return null;
    }
    
    console.log('Attempting to repair truncated JSON...');
    
    // Count unmatched brackets and braces
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escaped = false;
    
    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i];
        
        if (escaped) {
            escaped = false;
            continue;
        }
        
        if (char === '\\') {
            escaped = true;
            continue;
        }
        
        if (char === '"') {
            inString = !inString;
            continue;
        }
        
        if (!inString) {
            if (char === '{') {
                openBraces++;
            } else if (char === '}') {
                openBraces--;
            } else if (char === '[') {
                openBrackets++;
            } else if (char === ']') {
                openBrackets--;
            }
        }
    }
    
    // If we have unmatched brackets/braces, try to close them
    if (openBraces > 0 || openBrackets > 0) {
        let repaired = jsonStr;
        
        // Add missing closing brackets
        for (let i = 0; i < openBrackets; i++) {
            repaired += '\n  ]';
        }
        
        // Add missing closing braces
        for (let i = 0; i < openBraces; i++) {
            repaired += '\n}';
        }
        
        console.log(`Added ${openBrackets} closing brackets and ${openBraces} closing braces`);
        
        // Test if the repaired JSON is valid
        if (isValidJson(repaired)) {
            console.log('✅ Successfully repaired truncated JSON');
            return repaired;
        } else {
            console.log('❌ Could not repair JSON - still invalid after adding closers');
        }
    }
    
    return null;
}

// Root endpoint for Railway deployment verification
app.get('/', (req, res) => {
    res.json({
        message: 'Fundamental4 Railway Server',
        status: 'running',
        version: '1.0.1-fixed',
        endpoints: [
            'GET /health - Server health check',
            'POST /api/claim-tokens - Token claiming',
            'POST /api/claude - Claude API proxy',
            'POST /api/validate - Token validation',
            'POST /api/consume-tokens - Token consumption'
        ],
        timestamp: new Date().toISOString()
    });
});

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

// FIXED: Helper function to find user in Google Sheets (using Sheet1)
async function findUserInSheet(serialNumber) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        console.log(`Searching for serial number: ${serialNumber}`);
        
        // FIXED: Use Sheet1 instead of just the sheet name
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z', // FIXED: Use Sheet1 explicitly
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in spreadsheet');
            return null;
        }

        console.log(`Found ${rows.length} rows in spreadsheet`);
        
        // Find header row to identify columns
        const headers = rows[0];
        console.log('Headers found:', headers);
        
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

// FIXED: Helper function to search for order by order number (using Sheet1)
async function findOrderInSheet(orderNumber) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        console.log(`Searching for order number: ${orderNumber}`);
        
        // FIXED: Use Sheet1 instead of Orders sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z', // FIXED: Use Sheet1 where your data actually is
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No order data found in spreadsheet');
            return null;
        }

        console.log(`Found ${rows.length} order rows in spreadsheet`);
        
        // Find header row to identify columns
        const headers = rows[0];
        console.log('Available columns:', headers);
        
        // FIXED: Look for ClientOrder column (based on your actual data structure)
        const orderColumnIndex = headers.findIndex(header => 
            header && (header.toLowerCase().includes('clientorder') || header.toLowerCase().includes('order'))
        );
        const tokensColumnIndex = headers.findIndex(header => 
            header && header.toLowerCase().includes('token')
        );

        console.log(`Order column index: ${orderColumnIndex}, Tokens column index: ${tokensColumnIndex}`);

        if (orderColumnIndex === -1) {
            throw new Error('Could not find Order column in spreadsheet');
        }

        // Search for the order number
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowOrderNumber = row[orderColumnIndex];
            
            // Handle order numbers with or without # prefix
            const cleanOrderNumber = orderNumber.replace('#', '');
            const cleanRowOrderNumber = (rowOrderNumber || '').replace('#', '');
            
            console.log(`Comparing "${cleanRowOrderNumber}" with "${cleanOrderNumber}"`);
            
            if (cleanRowOrderNumber === cleanOrderNumber) {
                const tokens = tokensColumnIndex !== -1 ? (parseInt(row[tokensColumnIndex]) || 0) : 1000;
                console.log(`Found order: row ${i + 1}, tokens: ${tokens}`);
                return {
                    orderNumber: rowOrderNumber,
                    tokens: tokens,
                    rowIndex: i + 1
                };
            }
        }

        console.log('Order number not found in spreadsheet');
        return null;
    } catch (error) {
        console.error('Error searching orders in Google Sheets:', error);
        throw error;
    }
}

// Helper function to add tokens to user account
async function addTokensToUser(serialNumber, tokensToAdd) {
    const userInfo = await findUserInSheet(serialNumber);
    
    if (!userInfo) {
        // User doesn't exist, create new entry
        const headers = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!1:1', // FIXED: Use Sheet1
        });
        
        const headerRow = headers.data.values[0];
        const serialColumnIndex = headerRow.findIndex(header => 
            header && header.toLowerCase().includes('serial')
        );
        const tokenColumnIndex = headerRow.findIndex(header => 
            header && header.toLowerCase().includes('token')
        );
        
        // Find next empty row
        const allData = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z', // FIXED: Use Sheet1
        });
        
        const nextRow = allData.data.values.length + 1;
        const serialColumn = String.fromCharCode(65 + serialColumnIndex);
        const tokenColumn = String.fromCharCode(65 + tokenColumnIndex);
        
        // Add new user
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: `Sheet1!${serialColumn}${nextRow}:${tokenColumn}${nextRow}`, // FIXED: Use Sheet1
            valueInputOption: 'RAW',
            requestBody: {
                values: [[serialNumber, tokensToAdd]]
            }
        });
        
        return { newTokens: tokensToAdd, previousTokens: 0 };
    } else {
        // User exists, add to existing tokens
        const newTokenValue = userInfo.currentTokens + tokensToAdd;
        await updateTokensInSheet(userInfo.rowIndex, userInfo.tokenColumnIndex, newTokenValue);
        
        return { newTokens: newTokenValue, previousTokens: userInfo.currentTokens };
    }
}

// Helper function to update tokens in Google Sheets
async function updateTokensInSheet(rowIndex, columnIndex, newTokenValue) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        const columnLetter = String.fromCharCode(65 + columnIndex);
        const range = `Sheet1!${columnLetter}${rowIndex}`; // FIXED: Use Sheet1
        
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

// NEW: Token claiming endpoint
app.post('/api/claim-tokens', authenticateRequest, async (req, res) => {
    console.log('Token claiming request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { order_number, serial_number, device_id } = req.body;
        
        if (!order_number || !serial_number || !device_id) {
            return res.status(400).json({ 
                error: 'Order number, serial number, and device ID are required' 
            });
        }
        
        // Check if Google Sheets is available
        if (!sheets) {
            console.log('Google Sheets not available for token claiming');
            return res.status(500).json({
                error: 'Token claiming service temporarily unavailable',
                timestamp: new Date().toISOString()
            });
        }
        
        try {
            // Step 1: Search for the order
            console.log('Searching for order:', order_number);
            const orderInfo = await findOrderInSheet(order_number);
            
            if (!orderInfo) {
                return res.json({
                    success: false,
                    error: 'Order number not found',
                    order_number: order_number,
                    timestamp: new Date().toISOString()
                });
            }
            
            // Step 2: Add tokens to user account
            console.log(`Adding ${orderInfo.tokens} tokens to user ${serial_number}`);
            const tokenResult = await addTokensToUser(serial_number, orderInfo.tokens);
            
            console.log(`✅ Successfully claimed ${orderInfo.tokens} tokens for order ${order_number}`);
            
            return res.json({
                success: true,
                order_number: order_number,
                serial_number: serial_number,
                device_id: device_id,
                tokens_claimed: orderInfo.tokens,
                new_token_balance: tokenResult.newTokens,
                previous_token_balance: tokenResult.previousTokens,
                timestamp: new Date().toISOString()
            });
            
        } catch (googleError) {
            console.error('Google Sheets token claiming error:', googleError);
            return res.status(500).json({
                success: false,
                error: 'Token claiming failed',
                details: googleError.message,
                order_number: order_number,
                serial_number: serial_number,
                timestamp: new Date().toISOString()
            });
        }
        
    } catch (error) {
        console.error('Token claiming error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Token claiming failed',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

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
            max_tokens: 2500, // Increased for complex sequences
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

                // NEW: Validate and repair JSON before sending to client
                let finalResponseText = responseText;
                const extractedJson = extractJsonFromResponse(responseText);

                if (extractedJson) {
                    console.log('Found JSON in response, length:', extractedJson.length);
                    
                    if (isValidJson(extractedJson)) {
                        console.log('✅ JSON is valid');
                        finalResponseText = extractedJson;
                    } else {
                        console.log('❌ JSON is invalid, attempting repair...');
                        const repairedJson = repairTruncatedJson(extractedJson);
                        
                        if (repairedJson) {
                            console.log('✅ Successfully repaired JSON');
                            finalResponseText = repairedJson;
                        } else {
                            console.log('❌ Could not repair JSON, sending original response');
                            // Keep original response
                        }
                    }
                } else {
                    console.log('No JSON found in response, sending as-is');
                }
                
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
                    response: finalResponseText, // Use validated/repaired JSON
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
    console.log('✅ JSON validation and repair enabled');
    console.log('✅ Token claiming endpoint added');
    console.log('✅ FIXED: Google Sheets JWT authentication format');
    console.log('✅ FIXED: Using Sheet1 instead of Orders sheet');
    console.log('Environment check:');
    console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_SPREADSHEET_ID:', process.env.GOOGLE_SPREADSHEET_ID ? 'Present ✓' : 'Missing ✗');
    console.log('- Node.js version:', process.version);
    console.log('- Platform:', process.platform);
    console.log('\nServer ready to handle requests...');
});
