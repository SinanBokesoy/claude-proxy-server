const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config(); // CRITICAL: Load environment variables

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
        
        // CRITICAL FIX: Use object format for JWT constructor
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

// Root endpoint for Railway deployment verification
app.get('/', (req, res) => {
    res.json({
        message: 'Fundamental4 Railway Server - DEPLOY VERSION',
        status: 'running',
        version: '1.0.2-deploy',
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

// CRITICAL FIX: Helper function to search for order by order number (using Sheet1)
async function findOrderInSheet(orderNumber) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        console.log(`🔍 Searching for order number: ${orderNumber}`);
        
        // CRITICAL FIX: Use Sheet1 instead of Orders sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z', // FIXED: Use Sheet1 where your data actually is
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('❌ No order data found in spreadsheet');
            return null;
        }

        console.log(`📊 Found ${rows.length} order rows in spreadsheet`);
        
        // Find header row to identify columns
        const headers = rows[0];
        console.log('📋 Available columns:', headers);
        
        // CRITICAL FIX: Look for ClientOrder column (based on your actual data structure)
        const orderColumnIndex = headers.findIndex(header => 
            header && (header.toLowerCase().includes('clientorder') || header.toLowerCase().includes('order'))
        );
        const tokensColumnIndex = headers.findIndex(header => 
            header && header.toLowerCase().includes('token')
        );

        console.log(`🔍 Order column index: ${orderColumnIndex}, Tokens column index: ${tokensColumnIndex}`);

        if (orderColumnIndex === -1) {
            console.log('❌ Could not find Order column in spreadsheet');
            console.log('Available headers:', headers);
            throw new Error('Could not find Order column in spreadsheet');
        }

        // Search for the order number with detailed logging
        console.log(`🔍 Searching through ${rows.length - 1} data rows...`);
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowOrderNumber = row[orderColumnIndex];
            
            // Handle order numbers with or without # prefix
            const cleanOrderNumber = orderNumber.replace('#', '');
            const cleanRowOrderNumber = (rowOrderNumber || '').toString().replace('#', '');
            
            console.log(`🔍 Row ${i + 1}: Comparing "${cleanRowOrderNumber}" with "${cleanOrderNumber}"`);
            
            if (cleanRowOrderNumber === cleanOrderNumber) {
                const tokens = tokensColumnIndex !== -1 ? (parseInt(row[tokensColumnIndex]) || 0) : 1000;
                console.log(`✅ FOUND ORDER! Row ${i + 1}, tokens: ${tokens}`);
                return {
                    orderNumber: rowOrderNumber,
                    tokens: tokens,
                    rowIndex: i + 1
                };
            }
        }

        console.log('❌ Order number not found in spreadsheet after searching all rows');
        console.log('📋 Sample order values from first 5 rows:');
        for (let i = 1; i < Math.min(rows.length, 6); i++) {
            if (rows[i][orderColumnIndex]) {
                console.log(`  Row ${i + 1}: "${rows[i][orderColumnIndex]}"`);
            }
        }
        return null;
    } catch (error) {
        console.error('❌ Error searching orders in Google Sheets:', error);
        throw error;
    }
}

// Helper function to find user in Google Sheets (using Sheet1)
async function findUserInSheet(serialNumber) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        throw new Error('Google Sheets not initialized');
    }

    try {
        console.log(`Searching for serial number: ${serialNumber}`);
        
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in spreadsheet');
            return null;
        }

        console.log(`Found ${rows.length} rows in spreadsheet`);
        
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

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[serialColumnIndex] === serialNumber) {
                const tokens = parseInt(row[tokenColumnIndex]) || 0;
                console.log(`Found user: row ${i + 1}, tokens: ${tokens}`);
                return {
                    rowIndex: i + 1,
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

// Helper function to add tokens to user account
async function addTokensToUser(serialNumber, tokensToAdd) {
    const userInfo = await findUserInSheet(serialNumber);
    
    if (!userInfo) {
        const headers = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!1:1',
        });
        
        const headerRow = headers.data.values[0];
        const serialColumnIndex = headerRow.findIndex(header => 
            header && header.toLowerCase().includes('serial')
        );
        const tokenColumnIndex = headerRow.findIndex(header => 
            header && header.toLowerCase().includes('token')
        );
        
        const allData = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Sheet1!A:Z',
        });
        
        const nextRow = allData.data.values.length + 1;
        const serialColumn = String.fromCharCode(65 + serialColumnIndex);
        const tokenColumn = String.fromCharCode(65 + tokenColumnIndex);
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: `Sheet1!${serialColumn}${nextRow}:${tokenColumn}${nextRow}`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[serialNumber, tokensToAdd]]
            }
        });
        
        return { newTokens: tokensToAdd, previousTokens: 0 };
    } else {
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

// CRITICAL: Token claiming endpoint with enhanced logging
app.post('/api/claim-tokens', authenticateRequest, async (req, res) => {
    console.log('🎯 Token claiming request received:', JSON.stringify(req.body, null, 2));
    
    try {
        const { order_number, serial_number, device_id } = req.body;
        
        if (!order_number || !serial_number || !device_id) {
            return res.status(400).json({ 
                error: 'Order number, serial number, and device ID are required' 
            });
        }
        
        if (!sheets) {
            console.log('❌ Google Sheets not available for token claiming');
            return res.status(500).json({
                error: 'Token claiming service temporarily unavailable',
                timestamp: new Date().toISOString()
            });
        }
        
        try {
            console.log(`🔍 STEP 1: Searching for order: ${order_number}`);
            const orderInfo = await findOrderInSheet(order_number);
            
            if (!orderInfo) {
                console.log(`❌ Order ${order_number} not found in spreadsheet`);
                return res.json({
                    success: false,
                    error: 'Order number not found',
                    order_number: order_number,
                    timestamp: new Date().toISOString()
                });
            }
            
            console.log(`✅ STEP 2: Order found! Adding ${orderInfo.tokens} tokens to user ${serial_number}`);
            const tokenResult = await addTokensToUser(serial_number, orderInfo.tokens);
            
            console.log(`🎉 SUCCESS! Claimed ${orderInfo.tokens} tokens for order ${order_number}`);
            
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
            console.error('❌ Google Sheets token claiming error:', googleError);
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
        console.error('❌ Token claiming error:', error);
        res.status(500).json({ 
            success: false,
            error: 'Token claiming failed',
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
    console.log(`🚀 DEPLOY VERSION: Proxy server running on port ${PORT}`);
    console.log('✅ CRITICAL FIX: JWT authentication with object format');
    console.log('✅ CRITICAL FIX: Using Sheet1 for all operations');
    console.log('✅ CRITICAL FIX: dotenv configuration loaded');
    console.log('✅ Enhanced logging for order search');
    console.log('Environment check:');
    console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? 'Present ✓' : 'Missing ✗');
    console.log('- GOOGLE_SPREADSHEET_ID:', process.env.GOOGLE_SPREADSHEET_ID ? 'Present ✓' : 'Missing ✗');
    console.log('- Node.js version:', process.version);
    console.log('- Platform:', process.platform);
    console.log('\n🎯 Server ready to handle requests...');
});