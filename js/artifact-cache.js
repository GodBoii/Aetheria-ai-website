// js/artifact-cache.js - Artifact caching system

class ArtifactCache {
    constructor() {
        // Memory cache for fast access
        this.memoryCache = new Map();
        
        // IndexedDB for persistence
        this.dbName = 'ArtifactCacheDB';
        this.dbVersion = 1;
        this.storeName = 'artifacts';
        this.db = null;
        
        // Cache configuration
        this.config = {
            metadataExpiry: 50 * 60 * 1000, // 50 minutes (before presigned URL expires)
            contentExpiry: 60 * 60 * 1000,  // 1 hour
            maxMemoryCacheSize: 50,         // Max items in memory
            maxContentSize: 10 * 1024 * 1024 // 10MB per file
        };
        
        this.initDB();
    }

    /**
     * Initialize IndexedDB
     */
    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => {
                console.error('[ArtifactCache] IndexedDB error:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                this.db = request.result;
                console.log('[ArtifactCache] IndexedDB initialized');
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create object store if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const objectStore = db.createObjectStore(this.storeName, { keyPath: 'key' });
                    objectStore.createIndex('timestamp', 'timestamp', { unique: false });
                    objectStore.createIndex('expiresAt', 'expiresAt', { unique: false });
                    console.log('[ArtifactCache] Object store created');
                }
            };
        });
    }

    /**
     * Generate cache key
     */
    generateKey(type, artifactId) {
        return `${type}-${artifactId}`;
    }

    /**
     * Check if cached data is expired
     */
    isExpired(expiresAt) {
        return Date.now() > expiresAt;
    }

    /**
     * Get from memory cache
     */
    getFromMemory(key) {
        const cached = this.memoryCache.get(key);
        if (!cached) return null;
        
        if (this.isExpired(cached.expiresAt)) {
            this.memoryCache.delete(key);
            return null;
        }
        
        console.log('[ArtifactCache] Memory cache HIT:', key);
        return cached.data;
    }

    /**
     * Set in memory cache
     */
    setInMemory(key, data, expiresAt) {
        // Enforce memory cache size limit (LRU eviction)
        if (this.memoryCache.size >= this.config.maxMemoryCacheSize) {
            const firstKey = this.memoryCache.keys().next().value;
            this.memoryCache.delete(firstKey);
        }
        
        this.memoryCache.set(key, {
            data,
            timestamp: Date.now(),
            expiresAt
        });
    }

    /**
     * Get from IndexedDB
     */
    async getFromDB(key) {
        if (!this.db) {
            await this.initDB();
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.get(key);
            
            request.onsuccess = () => {
                const result = request.result;
                if (!result) {
                    resolve(null);
                    return;
                }
                
                if (this.isExpired(result.expiresAt)) {
                    // Delete expired entry
                    this.deleteFromDB(key);
                    resolve(null);
                    return;
                }
                
                console.log('[ArtifactCache] IndexedDB cache HIT:', key);
                
                // Also store in memory for faster subsequent access
                this.setInMemory(key, result.data, result.expiresAt);
                
                resolve(result.data);
            };
            
            request.onerror = () => {
                console.error('[ArtifactCache] IndexedDB get error:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Set in IndexedDB
     */
    async setInDB(key, data, expiresAt) {
        if (!this.db) {
            await this.initDB();
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            
            const record = {
                key,
                data,
                timestamp: Date.now(),
                expiresAt
            };
            
            const request = objectStore.put(record);
            
            request.onsuccess = () => {
                resolve();
            };
            
            request.onerror = () => {
                console.error('[ArtifactCache] IndexedDB set error:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Delete from IndexedDB
     */
    async deleteFromDB(key) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.delete(key);
            
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get artifact metadata (hybrid cache)
     */
    async getMetadata(artifactId) {
        const key = this.generateKey('metadata', artifactId);
        
        // Try memory cache first
        const memoryData = this.getFromMemory(key);
        if (memoryData) return memoryData;
        
        // Try IndexedDB
        const dbData = await this.getFromDB(key);
        return dbData;
    }

    /**
     * Set artifact metadata (hybrid cache)
     */
    async setMetadata(artifactId, metadata) {
        const key = this.generateKey('metadata', artifactId);
        const expiresAt = Date.now() + this.config.metadataExpiry;
        
        // Store in memory
        this.setInMemory(key, metadata, expiresAt);
        
        // Store in IndexedDB
        try {
            await this.setInDB(key, metadata, expiresAt);
        } catch (error) {
            console.error('[ArtifactCache] Failed to store metadata in IndexedDB:', error);
        }
    }

    /**
     * Get artifact content (hybrid cache)
     */
    async getContent(artifactId) {
        const key = this.generateKey('content', artifactId);
        
        // Try memory cache first
        const memoryData = this.getFromMemory(key);
        if (memoryData) return memoryData;
        
        // Try IndexedDB
        const dbData = await this.getFromDB(key);
        return dbData;
    }

    /**
     * Set artifact content (hybrid cache)
     */
    async setContent(artifactId, content) {
        // Check content size
        const contentSize = new Blob([content]).size;
        if (contentSize > this.config.maxContentSize) {
            console.warn('[ArtifactCache] Content too large to cache:', contentSize, 'bytes');
            return;
        }
        
        const key = this.generateKey('content', artifactId);
        const expiresAt = Date.now() + this.config.contentExpiry;
        
        // Store in memory
        this.setInMemory(key, content, expiresAt);
        
        // Store in IndexedDB
        try {
            await this.setInDB(key, content, expiresAt);
        } catch (error) {
            console.error('[ArtifactCache] Failed to store content in IndexedDB:', error);
        }
    }

    /**
     * Clear all caches
     */
    async clearAll() {
        console.log('[ArtifactCache] Clearing all caches');
        
        // Clear memory cache
        this.memoryCache.clear();
        
        // Clear IndexedDB
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const request = objectStore.clear();
            
            request.onsuccess = () => {
                console.log('[ArtifactCache] IndexedDB cleared');
                resolve();
            };
            
            request.onerror = () => {
                console.error('[ArtifactCache] IndexedDB clear error:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Clear expired entries from IndexedDB
     */
    async clearExpired() {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const objectStore = transaction.objectStore(this.storeName);
            const index = objectStore.index('expiresAt');
            
            // Get all entries that expire before now
            const range = IDBKeyRange.upperBound(Date.now());
            const request = index.openCursor(range);
            
            let deletedCount = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    console.log('[ArtifactCache] Cleared', deletedCount, 'expired entries');
                    resolve(deletedCount);
                }
            };
            
            request.onerror = () => {
                console.error('[ArtifactCache] Clear expired error:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Get cache statistics
     */
    async getStats() {
        const memorySize = this.memoryCache.size;
        
        let dbSize = 0;
        if (this.db) {
            dbSize = await new Promise((resolve) => {
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const objectStore = transaction.objectStore(this.storeName);
                const request = objectStore.count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(0);
            });
        }
        
        return {
            memorySize,
            dbSize,
            maxMemorySize: this.config.maxMemoryCacheSize
        };
    }
}

// Export singleton instance
export const artifactCache = new ArtifactCache();
