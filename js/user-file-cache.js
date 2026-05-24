class UserFileCache {
    constructor() {
        this.dbName = 'UserFileVaultCacheDB';
        this.dbVersion = 1;
        this.storeName = 'files';
        this.db = null;
        this.initPromise = null;
    }

    async initDB() {
        if (this.db) return this.db;
        if (this.initPromise) return this.initPromise;

        this.initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                }
            };
        });

        return this.initPromise;
    }

    async withStore(mode, callback) {
        const db = await this.initDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([this.storeName], mode);
            const store = tx.objectStore(this.storeName);
            let result;

            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);

            try {
                result = callback(store, tx);
            } catch (error) {
                reject(error);
            }
        });
    }

    normalizeRemoteRow(row = {}) {
        return {
            id: String(row.id || ''),
            file_name: row.file_name || 'Untitled',
            mime_type: row.mime_type || 'application/octet-stream',
            size_bytes: Number(row.size_bytes || 0),
            created_at: row.created_at || null,
            storage_path: row.storage_path || '',
            tags: Array.isArray(row.tags) ? row.tags : [],
            updatedAt: Date.now(),
        };
    }

    async getRecord(fileId) {
        const id = String(fileId || '');
        if (!id) return null;
        const requestResult = await this.withStore('readonly', (store) => store.get(id));
        return await new Promise((resolve, reject) => {
            requestResult.onsuccess = () => resolve(requestResult.result || null);
            requestResult.onerror = () => reject(requestResult.error);
        });
    }

    async upsertMetadataRows(rows = []) {
        const items = Array.isArray(rows) ? rows.filter((row) => row?.id) : [];
        if (!items.length) return;

        await this.withStore('readwrite', (store) => {
            items.forEach((row) => {
                const id = String(row.id);
                const getReq = store.get(id);
                getReq.onsuccess = () => {
                    const previous = getReq.result || {};
                    const normalized = this.normalizeRemoteRow(row);
                    store.put({
                        ...previous,
                        ...normalized,
                        blob: previous.blob || null,
                        local_cached_at: previous.local_cached_at || null,
                    });
                };
            });
        });
    }

    async saveFileBlob(row = {}, blob) {
        if (!row?.id || !blob) return;
        const id = String(row.id);
        await this.withStore('readwrite', (store) => {
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const previous = getReq.result || {};
                const normalized = this.normalizeRemoteRow(row);
                store.put({
                    ...previous,
                    ...normalized,
                    blob,
                    local_cached_at: Date.now(),
                    updatedAt: Date.now(),
                });
            };
        });
    }

    async deleteFile(fileId) {
        const id = String(fileId || '');
        if (!id) return;
        await this.withStore('readwrite', (store) => store.delete(id));
    }

    async listRows() {
        const allReq = await this.withStore('readonly', (store) => store.getAll());
        const rows = await new Promise((resolve, reject) => {
            allReq.onsuccess = () => resolve(Array.isArray(allReq.result) ? allReq.result : []);
            allReq.onerror = () => reject(allReq.error);
        });
        return rows.map((row) => ({
            id: row.id,
            file_name: row.file_name || 'Untitled',
            mime_type: row.mime_type || 'application/octet-stream',
            size_bytes: Number(row.size_bytes || 0),
            created_at: row.created_at || null,
            storage_path: row.storage_path || '',
            tags: Array.isArray(row.tags) ? row.tags : [],
            local_available: !!row.blob,
            local_cached_at: row.local_cached_at || null,
            updatedAt: Number(row.updatedAt || 0),
        }));
    }

    async getFileBlob(fileId) {
        const row = await this.getRecord(fileId);
        return row?.blob || null;
    }

    async hasLocalBlob(fileId) {
        const row = await this.getRecord(fileId);
        return !!row?.blob;
    }
}

export const userFileCache = new UserFileCache();
