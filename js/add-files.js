// js/add-files.js (Corrected with Preview Fix)

import { supabase } from './supabase-client.js';
import { chatModule } from './chat.js';

// Backend URL for file upload API - Production (Cloudflare Tunnel)
const API_PROXY_URL = 'https://api.aetheriaai.website';

class FileAttachmentHandler {
  constructor() {
    this.supportedFileTypes = {
      // Text/Code files
      'txt': 'text/plain', 'md': 'text/markdown', 'js': 'text/javascript', 'jsx': 'text/javascript',
      'ts': 'text/typescript', 'tsx': 'text/typescript', 'py': 'text/x-python', 'java': 'text/x-java',
      'cpp': 'text/x-c++', 'c': 'text/x-c', 'h': 'text/x-c', 'cs': 'text/x-csharp',
      'php': 'text/x-php', 'rb': 'text/x-ruby', 'go': 'text/x-go', 'rs': 'text/x-rust',
      'swift': 'text/x-swift', 'kt': 'text/x-kotlin', 'scala': 'text/x-scala',
      'html': 'text/html', 'htm': 'text/html', 'xml': 'text/xml', 'css': 'text/css',
      'scss': 'text/x-scss', 'sass': 'text/x-sass', 'less': 'text/x-less',
      'json': 'application/json', 'yaml': 'text/yaml', 'yml': 'text/yaml',
      'sql': 'text/x-sql', 'sh': 'text/x-sh', 'bat': 'text/x-bat', 'ps1': 'text/x-powershell',
      // Documents
      'pdf': 'application/pdf',
      'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'odt': 'application/vnd.oasis.opendocument.text', 'ods': 'application/vnd.oasis.opendocument.spreadsheet',
      'odp': 'application/vnd.oasis.opendocument.presentation',
      'rtf': 'application/rtf', 'csv': 'text/csv',
      // Images
      'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
      'bmp': 'image/bmp', 'webp': 'image/webp', 'svg': 'image/svg+xml', 'ico': 'image/x-icon',
      'tiff': 'image/tiff', 'tif': 'image/tiff',
      // Audio
      'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
      'aac': 'audio/aac', 'flac': 'audio/flac', 'wma': 'audio/x-ms-wma',
      // Video
      'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska', 'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv',
      // Archives
      'zip': 'application/zip', 'rar': 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
      'tar': 'application/x-tar', 'gz': 'application/gzip'
    };
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
    this.attachedFiles = [];
    this.initialize();
    if (typeof window !== 'undefined') {
      window.fileAttachmentHandler = this;
    }
  }

  initialize() {
    this.attachButton = document.getElementById('attach-file-btn');
    this.fileInput = document.getElementById('file-input');
    this.previewsContainer = document.getElementById('file-previews-container');
    this.attachmentStrip = document.getElementById('attachment-strip');
    this.inputField = document.querySelector('#floating-input-container .input-field');
    this.inputContainer = document.getElementById('floating-input-container');
    this.textInput = document.getElementById('floating-input');
    this.dragOverlay = document.getElementById('file-drop-overlay');
    this.dragCounter = 0;

    this.previewModal = document.getElementById('file-preview-modal');
    this.previewContentArea = document.getElementById('preview-content-area');
    this.closePreviewBtn = this.previewModal?.querySelector('.close-preview-btn');

    this.fileInput?.addEventListener('change', (event) => {
      this.handleFileSelection(event);
    });

    this.closePreviewBtn?.addEventListener('click', () => this.hidePreview());
    this.previewModal?.addEventListener('click', (e) => {
      if (e.target === this.previewModal) {
        this.hidePreview();
      }
    });

    this.setupDragAndDrop();
    this.setupClipboardPaste();
  }

  openFilePicker() {
    this.fileInput?.click();
  }

  async uploadFileToSupabase(fileObject) {
    const file = fileObject.file;
    const controller = new AbortController();
    fileObject.uploadController = controller;

    await supabase.auth.refreshSession();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      throw new Error("User not authenticated. Please log in again.");
    }

    const response = await fetch(`${API_PROXY_URL}/api/generate-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify({ fileName: file.name }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Could not get an upload URL.');
    }

    const { signedURL, path } = await response.json();
    if (!signedURL) throw new Error('Server did not return a valid signed URL.');

    const uploadResponse = await fetch(signedURL, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
      signal: controller.signal
    });

    if (!uploadResponse.ok) throw new Error('File upload to cloud storage failed.');
    return path;
  }

  async handleFileSelection(event) {
    const files = Array.from(event.target.files || []);
    await this.addFiles(files);
    if (event.target) {
      event.target.value = '';
    }
  }

  async addFiles(files = []) {
    files = Array.from(files).filter(Boolean);
    if (!files.length) return;

    if (files.length + this.attachedFiles.length > 20) {
      chatModule.showNotification("You can attach a maximum of 20 files.", "warning");
      return;
    }

    for (const file of files) {
      if (file.size > this.maxFileSize) {
        chatModule.showNotification(`File too large: ${file.name}`, "warning");
        continue;
      }

      const fileIndex = this.attachedFiles.length;
      const ext = file.name.split('.').pop().toLowerCase();

      // Map extensions to backend-accepted MIME types
      const mimeTypeMap = {
        'pdf': 'application/pdf',
        'js': 'application/x-javascript',
        'jsx': 'application/x-javascript',
        'py': 'application/x-python',
        'txt': 'text/plain',
        'html': 'text/html',
        'htm': 'text/html',
        'css': 'text/css',
        'csv': 'text/csv',
        'xml': 'text/xml',
        'rtf': 'text/rtf'
      };

      // Backend-supported MIME types (excluding text/md as it's not supported)
      const backendSupportedMimeTypes = [
        'application/pdf',
        'application/x-javascript',
        'text/javascript',
        'application/x-python',
        'text/x-python',
        'text/plain',
        'text/html',
        'text/css',
        'text/csv',
        'text/xml',
        'text/rtf'
      ];

      // Text file extensions that can be read as text
      const textExtensions = ['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'scala', 'sh', 'bat', 'ps1', 'yaml', 'yml', 'sql', 'rtf'];
      const isText = file.type.startsWith('text/') || textExtensions.includes(ext) || this.supportedFileTypes[ext]?.startsWith('text/');

      // Get the correct MIME type for backend
      let backendMimeType = file.type;
      if (mimeTypeMap[ext]) {
        backendMimeType = mimeTypeMap[ext];
      }

      // Check if backend supports this MIME type
      const isBackendSupported = backendSupportedMimeTypes.includes(backendMimeType);

      const fileObject = {
        id: `file_${Date.now()}_${fileIndex}`,
        name: file.name,
        type: file.type,
        backendMimeType: backendMimeType,
        status: 'uploading',
        isText,
        isBackendSupported,
        file,
        previewUrl: null
      };

      this.attachedFiles.push(fileObject);
      this.renderPreviews();

      try {
        if (fileObject.isText) {
          // Read text files as text content
          fileObject.content = await this.readFileAsText(file);
        } else {
          // Upload binary files (images, videos, audio, PDFs, documents) to Supabase
          fileObject.path = await this.uploadFileToSupabase(fileObject);
          // Generate preview URL for media files
          if (file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/')) {
            fileObject.previewUrl = await this.readFileAsDataURL(file);
          }
        }
        fileObject.status = 'completed';
      } catch (error) {
        if (error?.name === 'AbortError') {
          continue;
        }
        console.error(`Failed to process ${file.name}:`, error);
        fileObject.status = 'failed';
        fileObject.errorMessage = error.message || 'Upload failed.';
        chatModule.showNotification(`Upload failed for ${file.name}: ${error.message}`, "error");
      } finally {
        fileObject.uploadController = null;
      }

      this.renderPreviews();
    }
  }

  setupDragAndDrop() {
    const dropTarget = document.body;
    if (!dropTarget) return;

    dropTarget.addEventListener('dragenter', (event) => {
      if (!this.eventHasFiles(event)) return;
      event.preventDefault();
      this.dragCounter += 1;
      this.setDragOverlayVisible(true);
    });

    dropTarget.addEventListener('dragover', (event) => {
      if (!this.eventHasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this.setDragOverlayVisible(true);
    });

    dropTarget.addEventListener('dragleave', (event) => {
      if (!this.eventHasFiles(event)) return;
      event.preventDefault();
      this.dragCounter = Math.max(0, this.dragCounter - 1);
      if (this.dragCounter === 0) {
        this.setDragOverlayVisible(false);
      }
    });

    dropTarget.addEventListener('drop', async (event) => {
      if (!this.eventHasFiles(event)) return;
      event.preventDefault();
      this.dragCounter = 0;
      this.setDragOverlayVisible(false);
      await this.addFiles(event.dataTransfer.files);
    });
  }

  setupClipboardPaste() {
    const pasteTarget = this.textInput || document;
    pasteTarget.addEventListener('paste', async (event) => {
      const files = this.extractFilesFromClipboard(event.clipboardData);
      if (!files.length) return;

      event.preventDefault();
      await this.addFiles(files);
    });
  }

  eventHasFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
  }

  extractFilesFromClipboard(clipboardData) {
    if (!clipboardData) return [];

    const itemFiles = Array.from(clipboardData.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);

    if (itemFiles.length > 0) {
      return itemFiles.map((file, index) => this.normalizePastedFile(file, index));
    }

    return Array.from(clipboardData.files || []).filter(Boolean);
  }

  normalizePastedFile(file, index) {
    if (file.name) return file;

    const extension = this.getExtensionFromMimeType(file.type) || 'bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return new File([file], `pasted-file-${timestamp}-${index + 1}.${extension}`, {
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now()
    });
  }

  getExtensionFromMimeType(type = '') {
    const mimeMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/markdown': 'md',
      'text/csv': 'csv'
    };
    return mimeMap[type] || '';
  }

  setDragOverlayVisible(visible) {
    this.dragOverlay?.classList.toggle('visible', visible);
    this.inputContainer?.classList.toggle('drag-over', visible);
    document.body.classList.toggle('file-drag-active', visible);
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target.result);
      reader.onerror = (error) => reject(error);
      reader.readAsText(file);
    });
  }

  // ★★★ FIX: New function to read file as a Base64 Data URL ★★★
  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target.result);
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(file);
    });
  }

  renderPreviews() {
    if (!this.previewsContainer) return;
    this.previewsContainer.innerHTML = '';

    if (this.attachedFiles.length === 0) {
      this.attachmentStrip?.classList.add('hidden');
      this.inputField?.classList.remove('with-attachments');
      this.removeScrollListeners();
      return;
    }

    this.attachmentStrip?.classList.remove('hidden');
    this.inputField?.classList.add('with-attachments');

    this.attachedFiles.forEach((fileObject, index) => {
      const previewElement = document.createElement('div');
      previewElement.className = `file-preview-chip attachment-card ${fileObject.status}`;
      previewElement.setAttribute('role', 'listitem');
      previewElement.dataset.fileIndex = index;
      previewElement.title = fileObject.name;

      // Add image-file class for images
      if (fileObject.type.startsWith('image/')) {
        previewElement.classList.add('image-file');
      }

      // Create thumbnail container
      const thumbnailDiv = document.createElement('div');
      thumbnailDiv.className = 'file-thumbnail';

      // Show preview for images or icon for other files
      if (fileObject.type.startsWith('image/') && fileObject.previewUrl) {
        const img = document.createElement('img');
        img.className = 'attachment-card-thumb';
        img.src = fileObject.previewUrl;
        img.alt = fileObject.name;
        thumbnailDiv.appendChild(img);
      } else {
        // Show appropriate icon based on file type
        const iconElement = document.createElement('i');
        iconElement.className = 'file-icon fas';

        if (fileObject.type === 'application/pdf') {
          iconElement.classList.add('fa-file-pdf');
        } else if (fileObject.type.startsWith('video/')) {
          iconElement.classList.add('fa-file-video');
        } else if (fileObject.type.startsWith('audio/')) {
          iconElement.classList.add('fa-file-audio');
        } else if (fileObject.type.includes('word') || fileObject.type.includes('document')) {
          iconElement.classList.add('fa-file-word');
        } else if (fileObject.type.includes('excel') || fileObject.type.includes('spreadsheet') || fileObject.name.endsWith('.csv')) {
          iconElement.classList.add('fa-file-excel');
        } else if (fileObject.type.includes('powerpoint') || fileObject.type.includes('presentation')) {
          iconElement.classList.add('fa-file-powerpoint');
        } else if (fileObject.type.includes('zip') || fileObject.type.includes('rar') || fileObject.type.includes('7z') || fileObject.type.includes('tar') || fileObject.type.includes('gzip')) {
          iconElement.classList.add('fa-file-archive');
        } else if (fileObject.name.match(/\.(js|jsx|ts|tsx|py|java|cpp|c|cs|php|rb|go|rs|swift|kt|scala|html|css|json|xml|sql|sh|md)$/i)) {
          iconElement.classList.add('fa-file-code');
        } else {
          iconElement.classList.add('fa-file');
        }

        thumbnailDiv.appendChild(iconElement);
      }

      // Create file name label (shown for non-image files)
      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name attachment-card-name';
      nameSpan.textContent = fileObject.name;

      // Create remove button (X in top-left corner)
      const removeButton = document.createElement('button');
      removeButton.className = 'remove-file-btn attachment-card-remove';
      removeButton.dataset.index = index;
      removeButton.title = 'Remove file';
      removeButton.innerHTML = '<i class="fas fa-times"></i>';
      removeButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const indexToRemove = parseInt(e.currentTarget.dataset.index, 10);
        const fileToRemove = this.attachedFiles[indexToRemove];
        if (fileToRemove?.status === 'uploading') {
          fileToRemove.uploadController?.abort();
        }
        this.removeFile(indexToRemove);
      });

      // Click on card to preview (if available)
      previewElement.addEventListener('click', (e) => {
        if (!e.target.closest('.remove-file-btn, .retry-file-btn')) {
          this.showFilePreview(fileObject);
        }
      });

      previewElement.appendChild(thumbnailDiv);
      previewElement.appendChild(nameSpan);
      previewElement.appendChild(removeButton);

      // Add indicator for unsupported files
      if (fileObject.isText && !fileObject.isBackendSupported && fileObject.status === 'completed') {
        const indicator = document.createElement('div');
        indicator.className = 'file-processing-indicator';
        indicator.title = 'Content will be included in message';
        indicator.innerHTML = '<i class="fas fa-file-alt"></i>';
        previewElement.appendChild(indicator);
      }

      if (fileObject.status === 'failed') {
        const retryButton = document.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'retry-file-btn';
        retryButton.title = fileObject.errorMessage || 'Retry upload';
        retryButton.innerHTML = '<i class="fas fa-rotate-right"></i>';
        retryButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.retryUpload(index);
        });
        previewElement.appendChild(retryButton);
      }

      this.previewsContainer.appendChild(previewElement);
    });

    window.contextHandler?.updateContextFilesBarVisibility?.();
  }

  showPreview(index) {
    const fileObject = this.attachedFiles[index];
    this.showFilePreview(fileObject);
  }

  showFilePreview(fileObject) {
    if (!fileObject || !this.previewModal) return;

    let contentHTML = '';
    const safeName = this.escapeHtml(fileObject.name);
    const safePreviewUrl = fileObject.previewUrl ? encodeURI(fileObject.previewUrl) : '';
    if (fileObject.type?.startsWith('image/') && safePreviewUrl) {
      contentHTML = `
            <div class="preview-header">
              <h3 class="preview-title">${safeName}</h3>
            </div>
            <img src="${safePreviewUrl}" alt="Preview of ${safeName}">
          `;
    } else if (fileObject.type?.startsWith('video/') && safePreviewUrl) {
      contentHTML = `<video src="${safePreviewUrl}" controls autoplay></video>`;
    } else if (fileObject.type?.startsWith('audio/') && safePreviewUrl) {
      contentHTML = `<audio src="${safePreviewUrl}" controls autoplay></audio>`;
    } else if (fileObject.type === 'application/pdf' && safePreviewUrl) {
      contentHTML = `<iframe class="pdf-preview" src="${safePreviewUrl}"></iframe>`;
    } else if (fileObject.content) {
      contentHTML = `
            <div class="preview-header">
              <h3 class="preview-title">${safeName}</h3>
            </div>
            <pre class="file-content-preview">${this.escapeHtml(fileObject.content)}</pre>
          `;
    } else {
      contentHTML = `<p>Preview is not available for this file type.</p>`;
    }

    this.previewContentArea.innerHTML = contentHTML;
    this.previewModal.classList.remove('hidden');
  }

  hidePreview() {
    if (!this.previewModal) return;
    this.previewModal.classList.add('hidden');
    this.previewContentArea.innerHTML = '';
  }

  removeFile(index) {
    this.attachedFiles[index]?.uploadController?.abort();
    this.attachedFiles.splice(index, 1);
    this.renderPreviews();
  }

  async retryUpload(index) {
    const fileObject = this.attachedFiles[index];
    if (!fileObject || fileObject.status === 'uploading') return;

    fileObject.status = 'uploading';
    fileObject.errorMessage = '';
    fileObject.path = null;
    this.renderPreviews();

    try {
      if (fileObject.isText) {
        fileObject.content = await this.readFileAsText(fileObject.file);
      } else {
        fileObject.path = await this.uploadFileToSupabase(fileObject);
        if ((fileObject.type.startsWith('image/') || fileObject.type.startsWith('video/') || fileObject.type.startsWith('audio/')) && !fileObject.previewUrl) {
          fileObject.previewUrl = await this.readFileAsDataURL(fileObject.file);
        }
      }
      fileObject.status = 'completed';
    } catch (error) {
      if (error?.name === 'AbortError') return;
      fileObject.status = 'failed';
      fileObject.errorMessage = error.message || 'Upload failed.';
      chatModule.showNotification(`Upload failed for ${fileObject.name}: ${fileObject.errorMessage}`, "error");
    } finally {
      fileObject.uploadController = null;
      this.renderPreviews();
    }
  }

  getAttachedFiles() {
    return this.attachedFiles.filter(file => file.status === 'completed');
  }

  clearAttachedFiles() {
    this.attachedFiles = [];
    this.renderPreviews();
  }

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  getFileIcon(fileName = '', type = '') {
    const name = String(fileName || '').toLowerCase();
    if (type === 'application/pdf' || name.endsWith('.pdf')) return 'fas fa-file-pdf';
    if (type.startsWith('image/')) return 'fas fa-file-image';
    if (type.startsWith('video/')) return 'fas fa-file-video';
    if (type.startsWith('audio/')) return 'fas fa-file-audio';
    if (type.includes('word') || type.includes('document') || name.match(/\.(doc|docx|odt|rtf)$/)) return 'fas fa-file-word';
    if (type.includes('excel') || type.includes('spreadsheet') || name.match(/\.(xls|xlsx|csv|ods)$/)) return 'fas fa-file-excel';
    if (type.includes('powerpoint') || type.includes('presentation') || name.match(/\.(ppt|pptx|odp)$/)) return 'fas fa-file-powerpoint';
    if (type.includes('zip') || type.includes('archive') || name.match(/\.(zip|rar|7z|tar|gz)$/)) return 'fas fa-file-archive';
    if (name.match(/\.(js|jsx|ts|tsx|py|java|cpp|c|h|cs|php|rb|go|rs|swift|kt|scala|html|css|json|xml|sql|sh|md|yaml|yml)$/)) return 'fas fa-file-code';
    return 'fas fa-file';
  }

  removeScrollListeners() {
    // Placeholder method - no scroll listeners to remove in current implementation
  }
}

export default FileAttachmentHandler;
