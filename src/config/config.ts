/**
 * Global Application Configuration
 * All environment variables are centralized here
 */
export const config = {
    app: {
        port: Number(process.env.PORT) || 3000,
        appUrl: process.env.APP_URL || 'http://localhost:4000',
        env: process.env.NODE_ENV || 'development',
        jwtSecret: process.env.JWT_SECRET || 'supersecretkey',
        jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'superrefreshsecretkey',
        apiKey: process.env.API_KEY || 'secretapikey',
    },
    database: {
        dashboard: {
            host: process.env.DASHBOARD_DB_HOST || '127.0.0.1',
            port: Number(process.env.DASHBOARD_DB_PORT) || 3306,
            user: process.env.DASHBOARD_DB_USER || 'root',
            pass: process.env.DASHBOARD_DB_PASS || '',
            name: process.env.DASHBOARD_DB_NAME || 'dashboard',
            pool: Number(process.env.DASHBOARD_DB_POOL) || 10,
        },
        nis: {
            host: process.env.NIS_DB_HOST || '127.0.0.1',
            port: Number(process.env.NIS_DB_PORT) || 3306,
            user: process.env.NIS_DB_USER || 'root',
            pass: process.env.NIS_DB_PASS || '',
            name: process.env.NIS_DB_NAME || 'nis',
            pool: Number(process.env.NIS_DB_POOL) || 10,
        },
        nusafiber: {
            host: process.env.NUSAFIBER_DB_HOST || '127.0.0.1',
            port: Number(process.env.NUSAFIBER_DB_PORT) || 3306,
            user: process.env.NUSAFIBER_DB_USER || 'root',
            pass: process.env.NUSAFIBER_DB_PASS || '',
            name: process.env.NUSAFIBER_DB_NAME || 'nusafiber',
            pool: Number(process.env.NUSAFIBER_DB_POOL) || 10,
        },
        nusaprospect: {
            host: process.env.NUSAPROSPECT_DB_HOST || '127.0.0.1',
            port: Number(process.env.NUSAPROSPECT_DB_PORT) || 3306,
            user: process.env.NUSAPROSPECT_DB_USER || 'root',
            pass: process.env.NUSAPROSPECT_DB_PASS || '',
            name: process.env.NUSAPROSPECT_DB_NAME || 'nusaprospect',
            pool: Number(process.env.NUSAPROSPECT_DB_POOL) || 10,
        }
    },
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
    nusawork: {
        apiUrl: process.env.NUSAWORK_API_URL || '',
        clientId: process.env.NUSAWORK_CLIENT_ID || '',
        clientSecret: process.env.NUSAWORK_CLIENT_SECRET || '',
    },
    is5: {
        authUrl: process.env.IS5_AUTH_URL || '',
    },
    devLogin: {
        // Employee IDs allowed to log in without IS5 password check. Local development only — leave empty elsewhere.
        employeeIds: (process.env.DEV_LOGIN_EMPLOYEE_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
    },
    feedback: {
        scriptUrl: process.env.FEEDBACK_URL || '',
    },
    redis: {
        enabled: (process.env.CACHE_ENABLED || 'true').toLowerCase() === 'true',
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || '',
        db: Number(process.env.REDIS_DB) || 0,
        ttl: Number(process.env.REDIS_CACHE_TTL) || 86400,
    }
}