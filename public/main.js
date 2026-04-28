const API_URL = 'http://localhost:3000/api/v1/documents';
const API_KEY = 'local-dev-key-12345';

// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusContainer = document.getElementById('status-container');
const filenameLabel = document.getElementById('current-filename');
const badge = document.getElementById('current-badge');
const progressBar = document.getElementById('progress-bar');
const statusLogs = document.getElementById('status-logs');
const jsonViewer = document.getElementById('json-viewer');
const processingPulse = document.getElementById('processing-pulse');

// Event Listeners
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

// Preset Buttons
document.getElementById('load-sample-1').addEventListener('click', () => {
    loadSampleAndUpload('samples/japanise-offitial.pdf', 'japanise-offitial.pdf');
});
document.getElementById('load-sample-2').addEventListener('click', () => {
    loadSampleAndUpload('samples/japanise2offitial.pdf', 'japanise2offitial.pdf');
});

function logStatus(msg) {
    const el = document.createElement('div');
    el.innerText = `> ${msg}`;
    statusLogs.appendChild(el);
    statusLogs.scrollTop = statusLogs.scrollHeight;
}

function updateBadge(status) {
    badge.className = 'badge';
    if (status === 'QUEUED') {
        badge.classList.add('badge-pending');
        badge.innerText = 'Queued';
        progressBar.style.width = '20%';
    } else if (['PROCESSING', 'CLASSIFIED', 'EXTRACTED'].includes(status)) {
        badge.classList.add('badge-processing');
        badge.innerText = status;
        progressBar.style.width = status === 'CLASSIFIED' ? '50%' : (status === 'EXTRACTED' ? '75%' : '40%');
    } else if (status === 'COMPLETED' || status === 'STORED' || status === 'NEEDS_REVIEW') {
        badge.classList.add('badge-success');
        badge.innerText = 'Complete';
        progressBar.style.width = '100%';
    } else {
        badge.classList.add('badge-pending');
        badge.innerText = status || 'Unknown';
        progressBar.style.width = '0%';
    }
}

async function loadSampleAndUpload(url, filename) {
    statusContainer.classList.remove('hidden');
    jsonViewer.innerText = 'Fetching sample...';
    filenameLabel.innerText = filename;
    statusLogs.innerHTML = '';
    logStatus(`Downloading ${filename} locally...`);
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const file = new File([blob], filename, { type: 'application/pdf' });
        handleFile(file);
    } catch (e) {
        logStatus('Failed to load sample: ' + e.message);
    }
}

async function handleFile(file) {
    if (!file) return;

    statusContainer.classList.remove('hidden');
    processingPulse.classList.remove('hidden');
    filenameLabel.innerText = file.name;
    statusLogs.innerHTML = '';
    jsonViewer.innerText = 'Uploading...';
    
    updateBadge('QUEUED');
    logStatus(`Preparing file upload for ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    const formData = new FormData();
    formData.append('file', file);

    try {
        logStatus('Sending POST request to ingestion API...');
        const res = await fetch(`${API_URL}/upload`, {
            method: 'POST',
            headers: { 'x-api-key': API_KEY },
            body: formData
        });

        if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
        
        const data = await res.json();
        logStatus(`Upload successful. Document ID: ${data.documentId}`);
        
        pollStatus(data.documentId);
    } catch (err) {
        logStatus(`Error: ${err.message}`);
        updateBadge('FAILED');
        processingPulse.classList.add('hidden');
        jsonViewer.innerText = JSON.stringify({ error: err.message }, null, 2);
    }
}

async function pollStatus(documentId) {
    const pollInterval = 1500;
    
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`${API_URL}/${documentId}`, {
                headers: { 'x-api-key': API_KEY }
            });
            const doc = await res.json();
            
            updateBadge(doc.stage || doc.status);
            logStatus(`Polling: stage=${doc.stage}, status=${doc.status}`);

            // Update viewer natively
            jsonViewer.innerText = JSON.stringify(doc, null, 2);

            // Once it finishes processing components
            if (['COMPLETED', 'NEEDS_REVIEW', 'STORED', 'EXPOSED', 'FAILED'].includes(doc.status) || 
               ['STORED', 'EXPOSED'].includes(doc.stage)) {
                clearInterval(interval);
                processingPulse.classList.add('hidden');
                logStatus('Processing completed.');
                
                // Fetch extractions for detailed viewing
                try {
                    const extRes = await fetch(`${API_URL}/${documentId}/extractions`, {
                        headers: { 'x-api-key': API_KEY }
                    });
                    const extractions = await extRes.json();
                    
                    const canRes = await fetch(`${API_URL}/${documentId}/canonical`, {
                        headers: { 'x-api-key': API_KEY }
                    });
                    const canonicalJson = await canRes.json();

                    if (canonicalJson && canonicalJson.type === 'AUCTION_SHEET') {
                        jsonViewer.classList.add('hidden');
                        document.getElementById('table-viewer').classList.remove('hidden');
                        renderTable(canonicalJson.rows);
                    } else {
                        jsonViewer.classList.remove('hidden');
                        document.getElementById('table-viewer').classList.add('hidden');
                        const finalOutput = {
                            document: doc,
                            extractedBlocks: extractions
                        };
                        jsonViewer.innerText = JSON.stringify(finalOutput, null, 2);
                    }
                } catch(e) {
                    console.error("Error fetching detailed data", e);
                }
            }
        } catch (err) {
            logStatus(`Poll Error: ${err.message}`);
        }
    }, pollInterval);
}

function renderTable(rows) {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';
    
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="text-center">No rows extracted</td></tr>`;
        return;
    }
    
    rows.forEach(row => {
        const tr = document.createElement('tr');
        if (row.flags && row.flags.includes('INVALID_CHASSIS')) {
            tr.classList.add('row-invalid');
        }
        
        let confClass = 'conf-high';
        if (row.confidence < 0.7) confClass = 'conf-low';
        else if (row.confidence < 0.9) confClass = 'conf-med';
        
        const formatMoney = val => typeof val === 'number' ? val.toLocaleString('ja-JP') : '-';
        
        // Format flags into small badges
        let flagsHtml = '-';
        if (row.flags && row.flags.length > 0) {
            flagsHtml = row.flags.map(f => `<span style="font-size: 0.7rem; padding: 2px 4px; border-radius: 4px; background: rgba(255,255,255,0.1); margin: 2px; display: inline-block;">${f}</span>`).join('');
        }

        tr.innerHTML = `
            <td>${row.date || '-'}</td>
            <td>${row.lotNumber || '-'}</td>
            <td>${row.carName || '-'}</td>
            <td style="font-family: monospace;">${row.chassis || '-'}</td>
            <td>${row.auctionPlatform || '-'}</td>
            <td>${row.auctionLocation || '-'}</td>
            <td class="text-right">${formatMoney(row.startingPrice)}</td>
            <td class="text-right">${formatMoney(row.auctionFee)}</td>
            <td class="text-right" style="font-weight: 600">${formatMoney(row.finalPrice)}</td>
            <td class="${confClass}">${(row.confidence * 100).toFixed(0)}%</td>
            <td>${flagsHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}
