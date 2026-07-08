const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let cachedDb = null;

async function connectToDatabase() {
    if (cachedDb) return cachedDb;
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    cachedDb = client.db('earn_pkr');
    return cachedDb;
}

const JWT_SECRET = process.env.JWT_SECRET || 'earn_pkr_secret_2025';

exports.handler = async (event, context) => {
    const db = await connectToDatabase();
    const users = db.collection('users');
    const pending = db.collection('pending');
    const withdrawals = db.collection('withdrawals');
    
    const path = event.path.replace('/.netlify/functions/api', '');
    const method = event.httpMethod;
    
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    };
    
    if (method === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // ============ AUTH: SIGNUP ============
    if (path === '/auth/signup' && method === 'POST') {
        try {
            const { fullName, mobile, password } = JSON.parse(event.body);
            if (!fullName || !mobile || !password) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'All fields required' }) };
            }
            if (!/^03[0-9]{9}$/.test(mobile)) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid mobile number' }) };
            }
            if (password.length < 6) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) };
            }
            const existing = await users.findOne({ mobile });
            if (existing) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Mobile already registered' }) };
            }
            const hashed = await bcrypt.hash(password, 10);
            const newUser = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
                fullName,
                mobile,
                password: hashed,
                balance: 0,
                subscriptionActive: false,
                activePlan: null,
                activePlanName: null,
                adsWatchedToday: 0,
                lastAdDate: null,
                transactions: [],
                createdAt: new Date()
            };
            await users.insertOne(newUser);
            const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
            return {
                statusCode: 201,
                headers,
                body: JSON.stringify({
                    success: true,
                    token,
                    user: { id: newUser.id, fullName: newUser.fullName, mobile: newUser.mobile, balance: newUser.balance }
                })
            };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ AUTH: LOGIN ============
    if (path === '/auth/login' && method === 'POST') {
        try {
            const { mobile, password } = JSON.parse(event.body);
            const user = await users.findOne({ mobile });
            if (!user) {
                return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
            }
            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) {
                return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
            }
            const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    token,
                    user: { 
                        id: user.id, 
                        fullName: user.fullName, 
                        mobile: user.mobile, 
                        balance: user.balance, 
                        subscriptionActive: user.subscriptionActive, 
                        activePlan: user.activePlan, 
                        adsWatchedToday: user.adsWatchedToday, 
                        lastAdDate: user.lastAdDate, 
                        transactions: user.transactions 
                    }
                })
            };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ USER: GET PROFILE ============
    if (path === '/user/me' && method === 'GET') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await users.findOne({ id: decoded.id });
            if (!user) return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    id: user.id,
                    fullName: user.fullName,
                    mobile: user.mobile,
                    balance: user.balance,
                    subscriptionActive: user.subscriptionActive,
                    activePlan: user.activePlan,
                    adsWatchedToday: user.adsWatchedToday,
                    lastAdDate: user.lastAdDate,
                    transactions: user.transactions
                })
            };
        } catch (error) {
            return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
        }
    }

    // ============ USER: WATCH AD ============
    if (path === '/user/watch' && method === 'POST') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await users.findOne({ id: decoded.id });
            if (!user) return { statusCode: 404, headers, body: JSON.stringify({ error: 'User not found' }) };
            if (!user.subscriptionActive) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'No active plan' }) };
            }
            const today = new Date().toDateString();
            let adsToday = user.adsWatchedToday || 0;
            if (user.lastAdDate !== today) adsToday = 0;
            if (adsToday >= 20) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Daily limit reached' }) };
            }
            const earn = user.activePlan.perAd;
            const updated = await users.findOneAndUpdate(
                { id: user.id },
                { 
                    $inc: { balance: earn, adsWatchedToday: 1 },
                    $set: { lastAdDate: today },
                    $push: { transactions: { id: Date.now(), description: `📺 Ad +₨${earn}`, amount: earn, date: new Date() } }
                },
                { returnDocument: 'after' }
            );
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, earned: earn, user: updated.value })
            };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ DEPOSIT: REQUEST ============
    if (path === '/deposit/request' && method === 'POST') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const { plan } = JSON.parse(event.body);
            const amounts = { plan300: 300, plan500: 500, plan1000: 1000 };
            if (!amounts[plan]) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid plan' }) };
            const existing = await pending.findOne({ userId: decoded.id, status: 'pending' });
            if (existing) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pending request exists' }) };
            await pending.insertOne({
                requestId: Date.now(),
                userId: decoded.id,
                selectedPlan: plan,
                amount: amounts[plan],
                status: 'pending',
                createdAt: new Date()
            });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ WITHDRAWAL: REQUEST ============
    if (path === '/withdraw/request' && method === 'POST') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const { method, account, amount } = JSON.parse(event.body);
            if (amount < 300) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Minimum withdrawal ₨300' }) };
            const user = await users.findOne({ id: decoded.id });
            if (amount > user.balance) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Insufficient balance' }) };
            await users.updateOne({ id: decoded.id }, { $inc: { balance: -amount } });
            await withdrawals.insertOne({
                id: Date.now(),
                userId: decoded.id,
                fullName: user.fullName,
                mobile: user.mobile,
                method,
                account,
                amount,
                status: 'pending',
                date: new Date()
            });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: GET PENDING ============
    if (path === '/admin/pending' && method === 'GET') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            // Verify admin
            const decoded = jwt.verify(token, JWT_SECRET);
            const adminUser = await users.findOne({ id: decoded.id });
            if (!adminUser || !adminUser.isAdmin) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
            }
            const pendingRequests = await pending.find({ status: 'pending' }).toArray();
            return { statusCode: 200, headers, body: JSON.stringify(pendingRequests) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: ACTIVATE PLAN ============
    if (path === '/admin/activate' && method === 'POST') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const adminUser = await users.findOne({ id: decoded.id });
            if (!adminUser || !adminUser.isAdmin) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
            }
            const { userId, planKey } = JSON.parse(event.body);
            const bonusMap = { 
                plan300: { bonus: 200, totalAdd: 500, perAd: 5, name: '₨300 Plan' },
                plan500: { bonus: 500, totalAdd: 1000, perAd: 10, name: '₨500 Plan' },
                plan1000: { bonus: 1000, totalAdd: 2000, perAd: 20, name: '₨1000 Plan' }
            };
            const selected = bonusMap[planKey];
            if (!selected) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid plan' }) };
            await users.updateOne(
                { id: userId },
                { 
                    $inc: { balance: selected.totalAdd },
                    $set: { 
                        subscriptionActive: true, 
                        activePlan: { name: selected.name, perAd: selected.perAd, planId: planKey },
                        activePlanName: selected.name
                    },
                    $push: { transactions: { id: Date.now(), description: `✅ Activated ${selected.name} +₨${selected.totalAdd}`, amount: selected.totalAdd, date: new Date() } }
                }
            );
            await pending.deleteOne({ userId: userId, selectedPlan: planKey });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: GET ALL USERS ============
    if (path === '/admin/users' && method === 'GET') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const adminUser = await users.findOne({ id: decoded.id });
            if (!adminUser || !adminUser.isAdmin) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
            }
            const allUsers = await users.find({}).toArray();
            // Remove passwords for security
            const safeUsers = allUsers.map(u => ({ ...u, password: '🔒' }));
            return { statusCode: 200, headers, body: JSON.stringify(safeUsers) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: GET WITHDRAWALS ============
    if (path === '/admin/withdrawals' && method === 'GET') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const adminUser = await users.findOne({ id: decoded.id });
            if (!adminUser || !adminUser.isAdmin) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
            }
            const allWithdrawals = await withdrawals.find({ status: 'pending' }).toArray();
            return { statusCode: 200, headers, body: JSON.stringify(allWithdrawals) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: PROCESS WITHDRAWAL ============
    if (path === '/admin/withdraw/process' && method === 'POST') {
        try {
            const token = event.headers.authorization?.replace('Bearer ', '');
            if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
            const decoded = jwt.verify(token, JWT_SECRET);
            const adminUser = await users.findOne({ id: decoded.id });
            if (!adminUser || !adminUser.isAdmin) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
            }
            const { withdrawalId } = JSON.parse(event.body);
            await withdrawals.updateOne({ id: withdrawalId }, { $set: { status: 'completed' } });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }

    // ============ ADMIN: SET ADMIN ============
    if (path === '/admin/set' && method === 'POST') {
        try {
            const { mobile } = JSON.parse(event.body);
            const result = await users.updateOne({ mobile }, { $set: { isAdmin: true } });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, matched: result.matchedCount }) };
        } catch (error) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
        }
    }
    
    return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Route not found' })
    };
};