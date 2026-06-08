// Network configuration for OpenBazaar AI
// Handles decentralized network settings and federation

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class NetworkConfig {
    constructor() {
        this.configPath = path.join(__dirname, '../../frontend/brands/teneo/config.json');
        // SECURITY: the private key is stored OUTSIDE the committed config — in a
        // gitignored sidecar PEM or the NETWORK_PRIVATE_KEY env var — so it can never
        // be written into config.json and committed to the (public) repo.
        this.privateKeyPath = path.join(__dirname, '../../frontend/brands/teneo/.network-private-key.pem');
        this.networkEnabled = false;
        this.shareCatalog = false;
        this.acceptReferrals = false;
        this.referralPercentage = 0;
        this.publicKey = null;
        this.privateKey = null;
        this.networkPeers = [];
        this.trustedStores = [];
        this.federationSettings = {
            maxPeers: 50,
            syncInterval: 300000, // 5 minutes
            timeout: 30000, // 30 seconds
            retryAttempts: 3
        };

        this.init();
    }

    async init() {
        try {
            await this.loadConfig();
            await this.generateKeysIfNeeded();
        } catch (error) {
            console.error('Network config initialization failed:', error);
        }
    }

    async loadConfig() {
        try {
            const configData = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(configData);

            // Load network settings from brand config
            this.networkEnabled = config.network_enabled || false;
            this.shareCatalog = config.share_catalog || false;
            this.acceptReferrals = config.accept_referrals || false;
            this.referralPercentage = config.referral_percentage || 0;
            this.publicKey = config.public_key || null;
            this.networkPeers = config.network_peers || [];
            this.trustedStores = config.trusted_stores || [];

            // SECURITY: never load the private key from the committed config.json —
            // it comes from env or the gitignored sidecar only.
            this.privateKey = await this.loadPrivateKey();

            console.log('Network config loaded successfully');
        } catch (error) {
            console.log('No existing network config found, using defaults');
        }
    }

    // Private key source of truth: NETWORK_PRIVATE_KEY env first, then the
    // gitignored sidecar PEM. Returns null if neither exists.
    async loadPrivateKey() {
        if (process.env.NETWORK_PRIVATE_KEY) {
            return process.env.NETWORK_PRIVATE_KEY;
        }
        try {
            return await fs.readFile(this.privateKeyPath, 'utf8');
        } catch (error) {
            return null;
        }
    }

    // Persist the private key to the gitignored sidecar with owner-only perms.
    async savePrivateKey() {
        if (!this.privateKey) return;
        await fs.writeFile(this.privateKeyPath, this.privateKey, { mode: 0o600 });
    }

    async saveConfig() {
        try {
            // Load existing brand config
            let config = {};
            try {
                const configData = await fs.readFile(this.configPath, 'utf8');
                config = JSON.parse(configData);
            } catch (error) {
                // Create new config if doesn't exist
            }

            // Update network settings
            config.network_enabled = this.networkEnabled;
            config.share_catalog = this.shareCatalog;
            config.accept_referrals = this.acceptReferrals;
            config.referral_percentage = this.referralPercentage;
            config.public_key = this.publicKey;
            // SECURITY: never write the private key into the committed config.json.
            // It lives in the gitignored sidecar / env (see savePrivateKey).
            delete config.private_key;
            config.network_peers = this.networkPeers;
            config.trusted_stores = this.trustedStores;

            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
            console.log('Network config saved successfully');
        } catch (error) {
            console.error('Failed to save network config:', error);
            throw error;
        }
    }

    async generateKeysIfNeeded() {
        if (!this.publicKey || !this.privateKey) {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 2048,
                publicKeyEncoding: {
                    type: 'spki',
                    format: 'pem'
                },
                privateKeyEncoding: {
                    type: 'pkcs8',
                    format: 'pem'
                }
            });

            this.publicKey = publicKey;
            this.privateKey = privateKey;

            await this.savePrivateKey();
            await this.saveConfig();
        }
    }

    // Network status
    getNetworkStatus() {
        return {
            enabled: this.networkEnabled,
            publicKey: this.publicKey,
            peerCount: this.networkPeers.length,
            trustedStores: this.trustedStores.length,
            shareCatalog: this.shareCatalog,
            acceptReferrals: this.acceptReferrals,
            referralPercentage: this.referralPercentage,
            lastSync: new Date().toISOString()
        };
    }

    // Enable/disable network
    async setNetworkEnabled(enabled) {
        this.networkEnabled = enabled;
        await this.saveConfig();
    }

    // Configure catalog sharing
    async setCatalogSharing(enabled) {
        this.shareCatalog = enabled;
        await this.saveConfig();
    }

    // Configure referrals
    async setReferralSettings(acceptReferrals, percentage) {
        this.acceptReferrals = acceptReferrals;
        this.referralPercentage = Math.max(0, Math.min(100, percentage));
        await this.saveConfig();
    }

    // Add trusted store
    async addTrustedStore(storeId, publicKey, endpoint) {
        const store = {
            id: storeId,
            publicKey,
            endpoint,
            addedAt: new Date().toISOString(),
            verified: false
        };

        this.trustedStores.push(store);
        await this.saveConfig();
        return store;
    }

    // Remove trusted store
    async removeTrustedStore(storeId) {
        this.trustedStores = this.trustedStores.filter(store => store.id !== storeId);
        await this.saveConfig();
    }

    // Add network peer
    async addNetworkPeer(peerId, endpoint) {
        const peer = {
            id: peerId,
            endpoint,
            addedAt: new Date().toISOString(),
            lastSeen: null,
            status: 'pending'
        };

        this.networkPeers.push(peer);
        await this.saveConfig();
        return peer;
    }

    // Remove network peer
    async removeNetworkPeer(peerId) {
        this.networkPeers = this.networkPeers.filter(peer => peer.id !== peerId);
        await this.saveConfig();
    }

    // Sign message for network communication
    signMessage(message) {
        if (!this.privateKey) {
            throw new Error('Private key not available');
        }

        const sign = crypto.createSign('RSA-SHA256');
        sign.update(message);
        return sign.sign(this.privateKey, 'base64');
    }

    // Verify message from network peer
    verifyMessage(message, signature, peerPublicKey) {
        try {
            const verify = crypto.createVerify('RSA-SHA256');
            verify.update(message);
            return verify.verify(peerPublicKey, signature, 'base64');
        } catch (error) {
            console.error('Message verification failed:', error);
            return false;
        }
    }

    // Get network discovery info
    getDiscoveryInfo() {
        if (!this.networkEnabled) {
            return null;
        }

        return {
            storeId: process.env.STORE_ID || 'marketplace',
            name: process.env.MARKETPLACE_NAME || 'Book Marketplace',
            description: process.env.MARKETPLACE_DESCRIPTION || 'A decentralized marketplace for digital and print books',
            publicKey: this.publicKey,
            endpoint: process.env.NETWORK_ENDPOINT || process.env.PUBLIC_URL || 'http://localhost:3001',
            services: {
                catalog: this.shareCatalog,
                referrals: this.acceptReferrals,
                search: true
            },
            version: '1.0.0',
            timestamp: new Date().toISOString()
        };
    }

    // Network health check
    async healthCheck() {
        const status = {
            healthy: true,
            issues: []
        };

        // Check key pair
        if (!this.publicKey || !this.privateKey) {
            status.healthy = false;
            status.issues.push('Missing cryptographic keys');
        }

        // Check network connectivity (placeholder)
        if (this.networkEnabled && this.networkPeers.length === 0) {
            status.issues.push('No network peers configured');
        }

        return status;
    }

    // Get network statistics
    getNetworkStats() {
        return {
            peersConnected: this.networkPeers.filter(p => p.status === 'connected').length,
            peersTotal: this.networkPeers.length,
            trustedStores: this.trustedStores.length,
            catalogShared: this.shareCatalog,
            referralsEnabled: this.acceptReferrals,
            uptime: process.uptime(),
            lastConfigUpdate: new Date().toISOString()
        };
    }
}

// Singleton instance
const networkConfig = new NetworkConfig();

module.exports = networkConfig;
