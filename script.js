// ===== UTILITAIRES DE NETTOYAGE =====
function sanitizeKey(str) { return str.replace(/[^a-zA-Z0-9]/g, "_"); }
function sanitizeId(str) { return str.replace(/[^a-zA-Z0-9]/g, ""); }

// Sécurité: nettoyer la mémoire si elle est corrompue
try {
    if (!Array.isArray(JSON.parse(localStorage.getItem('offlineQueue')))) {
        localStorage.setItem('offlineQueue', '[]');
    }
} catch(e) { localStorage.setItem('offlineQueue', '[]'); }

// Initialisation des variables globales
let dataCache = {};
let vpoCodeIndex = {};
function buildVpoCodeIndex() {
    if (typeof data === 'undefined') return;
    for (const floor in data) {
        for (const room in data[floor]) {
            data[floor][room].forEach((eq, i) => {
                if (eq.code) vpoCodeIndex[eq.code.trim()] = { floor, room, index: i };
            });
        }
    }
}
function isEquipVpoConforme(code) {
    const ref = vpoCodeIndex[code];
    if (!ref) return false;
    const eq = data[ref.floor][ref.room][ref.index];
    const safeName = sanitizeKey(eq.nom);
    const allInspections = JSON.parse(localStorage.getItem('all_inspections')) || {};
    const saved = allInspections[ref.floor] && allInspections[ref.floor][ref.room] && allInspections[ref.floor][ref.room][safeName];
    if (!saved) return false;
    const detailsArray = Object.values(saved.details || {});
    const hasNC = detailsArray.some(d => d.etat === "NC" && d.nomOriginal !== 'Prérequis');
    const total = Object.keys(eq.details).filter(k => k !== 'Prérequis').length;
    const filled = detailsArray.filter(d => d.etat === "C" && d.nomOriginal !== 'Prérequis').length;
    return !hasNC && filled >= total;
}
function getMissingVpoPrereqs(eq) {
    const prereqStr = eq.details['Prérequis'];
    if (!prereqStr || prereqStr.trim() === '' || prereqStr.trim() === '-') return [];
    const codes = prereqStr.split(',').map(c => c.trim()).filter(Boolean);
    return codes.filter(c => !isEquipVpoConforme(c));
}
let isAppOnline = navigator.onLine;

// --- CETTE FONCTION S'EXÉCUTE QUAND LA PAGE EST PRÊTE ---
document.addEventListener('DOMContentLoaded', function() {
    
    // On s'assure que Firebase est chargé avant de définir 'db'
    if (typeof firebase !== 'undefined') {
        const db = firebase.database(); 

        // 1. Lancer l'authentification
        firebase.auth().signInAnonymously()
            .then(() => {
                console.log("✅ Authentifié avec succès !");
                db.ref('inspections').on('value', function(snapshot) {
                    if (snapshot.exists()) {
                        localStorage.setItem('all_inspections', JSON.stringify(snapshot.val()));
                    }
                });

                db.ref('.info/connected').on('value', function(snapshot) {
                    isAppOnline = snapshot.val() === true && navigator.onLine;
                    updateNetworkStatus();
                });
            })
            .catch((error) => {
                console.error("❌ Erreur Auth:", error.message);
                updateNetworkStatus();
            });
    }

    // 2. ACTIVER LES CLICS SUR LES PIÈCES
    document.addEventListener('click', function(e) {
        if (e.target && e.target.classList && e.target.classList.contains('room')) {
            const room = e.target;
            document.querySelectorAll('.room').forEach(r => r.classList.remove('selected'));
            room.classList.add('selected');
            
            const roomName = room.getAttribute('data-room');
            const floor = room.getAttribute('data-floor');
            
            console.log("Clic sur pièce :", roomName);
            if (typeof showEquipments === "function") {
                showEquipments(floor, roomName);
            }
        }
    });
});

// ===== GESTION DU RÉSEAU =====
window.addEventListener('online', () => { isAppOnline = true; updateNetworkStatus(); });
window.addEventListener('offline', () => { isAppOnline = false; updateNetworkStatus(); });

function updateNetworkStatus() {
    const statusEl = document.getElementById('network-status');
    if (!statusEl) return; 
    
    if (isAppOnline) {
        statusEl.innerHTML = "🟢 En ligne";
        statusEl.classList.remove('status-offline');
        syncOfflineData(); 
    } else {
        statusEl.innerHTML = "🔴 Hors ligne";
        statusEl.classList.add('status-offline');
    }
}

// ===== SYNCHRONISATION AUTOMATIQUE =====
function syncOfflineData() {
    if (typeof firebase === 'undefined') return;
    const db = firebase.database();
    let queue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
    if (queue.length === 0) return;

    const syncPromises = queue.map(item => {
        return db.ref(item.path).set(item.data)
            .then(() => item.path)
            .catch(err => {
                console.error("Échec sync:", item.path, err);
                return null;
            });
    });

    Promise.all(syncPromises).then(results => {
        const successfulPaths = results.filter(path => path !== null);
        if (successfulPaths.length > 0) {
            let currentQueue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
            let newQueue = currentQueue.filter(item => !successfulPaths.includes(item.path));
            localStorage.setItem('offlineQueue', JSON.stringify(newQueue));
            alert(`✅ ${successfulPaths.length} inspections synchronisées !`);
            
            const activeRoom = document.querySelector('.room.selected');
            if (activeRoom) showEquipments(activeRoom.dataset.floor, activeRoom.dataset.room);
        }
    });
}

// ===== CHANGEMENT D'ÉTAGE & PLAN =====
function showFloor(floorId) {
    const currentFloor = document.querySelector('.floor:not([style*="display: none"])');
    const targetFloor = document.getElementById(floorId);

    document.querySelectorAll('.floor-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('onclick').includes(floorId)) btn.classList.add('active');
    });

    if (currentFloor && currentFloor !== targetFloor) {
        currentFloor.style.opacity = "0";
        setTimeout(() => {
            currentFloor.style.display = "none";
            targetFloor.style.display = "block";
            setTimeout(() => targetFloor.style.opacity = "1", 10);
        }, 400);
    } else if (!currentFloor) {
        targetFloor.style.display = "block";
        setTimeout(() => targetFloor.style.opacity = "1", 10);
    }
    
    document.querySelectorAll('.room').forEach(r => r.classList.remove('selected'));
    document.getElementById("panel").innerHTML = "<p>Sélectionnez une pièce</p>";
}

// ===== AFFICHER LA LISTE (AVEC LES LOGOS D'ÉTAT) =====
function showEquipments(floor, roomNumber) {
    const panel = document.getElementById("panel");
    
    if (typeof data === 'undefined') {
        panel.innerHTML = `<p style="color:red; text-align:center;">Fichier Excel (data.js) introuvable.</p>`;
        return;
    }

    if (!data[floor] || !data[floor][roomNumber]) {
        panel.innerHTML = `<h3 class="room-title">Pièce ${roomNumber}</h3><p>Aucun équipement.</p>`;
        return;
    }

    const equipments = data[floor][roomNumber];
    let html = `<h3 class="room-title">Pièce ${roomNumber}</h3>`;

    const offlineQueue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
    const allInspections = JSON.parse(localStorage.getItem('all_inspections')) || {};

    if (Object.keys(vpoCodeIndex).length === 0) buildVpoCodeIndex();

    equipments.forEach((eq, index) => {
        const safeEqName = sanitizeKey(eq.nom);
        const firebasePath = 'inspections/' + floor + '/' + roomNumber + '/' + safeEqName;
        
        let statusClass = "status-grey";
        let statusSymbol = "o"; 
        
        const isOfflineSaved = offlineQueue.find(q => q.path === firebasePath);
        let savedData = null;
        
        if (allInspections[floor] && allInspections[floor][roomNumber] && allInspections[floor][roomNumber][safeEqName]) {
            savedData = allInspections[floor][roomNumber][safeEqName];
        }

        if (isOfflineSaved) {
            // JAUNE: Sauvegarde locale (Attente de synchronisation)
            statusClass = "status-yellow";
            statusSymbol = "💾";

        } else if (savedData) {
                    const detailsArray = Object.values(savedData.details || {});
                    const hasNC = detailsArray.some(d => d.etat === "NC" && d.nomOriginal !== 'Prérequis');
                    const totalProps = Object.keys(eq.details).filter(k => k !== 'Prérequis').length;
                    const filledProps = detailsArray.filter(d => d.etat === "C" && d.nomOriginal !== 'Prérequis').length;

                    if (hasNC) {
                        statusClass = "status-red";
                        statusSymbol = "!";
                    } else if (filledProps >= totalProps) {
                        statusClass = "status-green";
                        statusSymbol = "✓";
                    } else {
                        statusClass = "status-orange";
                        statusSymbol = "...";
                    }
                }

                const missingPrereqs = getMissingVpoPrereqs(eq);
                const prereqBadge = missingPrereqs.length > 0
                    ? `<span class="status-icon" style="background:#d32f2f;color:white;font-size:11px;" title="Manque: ${missingPrereqs.join(', ')}">🔒 ${missingPrereqs.length}</span>`
                    : '';

                html += `<button class="equipment-btn" onclick="openForm('${floor}','${roomNumber}', ${index})">
                            <span>${eq.nom}</span>
                            <span class="status-icon ${statusClass}">${statusSymbol}</span>${prereqBadge}
                        </button><br><br>`;
    });
    panel.innerHTML = html;
}

// ===== OUVRIR LE FORMULAIRE =====
function openForm(floor, roomNumber, index) {
    const panel = document.getElementById("panel");
    const eq = data[floor][roomNumber][index];
    const safeEqName = sanitizeKey(eq.nom);
    const firebasePath = 'inspections/' + floor + '/' + roomNumber + '/' + safeEqName;

    const offlineQueue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
    const allInspections = JSON.parse(localStorage.getItem('all_inspections')) || {};
    
    let savedData = {}; 
    const queuedItem = offlineQueue.find(q => q.path === firebasePath);
    
    if (queuedItem) {
        savedData = queuedItem.data;
    } else if (allInspections[floor] && allInspections[floor][roomNumber] && allInspections[floor][roomNumber][safeEqName]) {
        savedData = allInspections[floor][roomNumber][safeEqName];
    }

    if (!isAppOnline || typeof firebase === 'undefined') {
        renderForm(savedData, floor, roomNumber, index);
        return; 
    }

    panel.innerHTML = `<div class="spinner"></div><p style="text-align:center; font-weight:bold; color:#7f8c8d;">Chargement...</p>`;

    const db = firebase.database();
    let isResolved = false;
    db.ref(firebasePath).once('value').then((snapshot) => {
        isResolved = true;
        renderForm(snapshot.val() || savedData, floor, roomNumber, index);
    }).catch(() => {
        isResolved = true;
        renderForm(savedData, floor, roomNumber, index); 
    });

    setTimeout(() => { if (!isResolved) renderForm(savedData, floor, roomNumber, index); }, 3000);
}

// ===== GÉNÉRATION DU FORMULAIRE =====
function renderForm(savedData, floor, roomNumber, index) {
    const panel = document.getElementById("panel");
    const eq = data[floor][roomNumber][index];
    const eqSaved = savedData.details || {};

    const missing = getMissingVpoPrereqs(eq);
    const prereqInfo = missing.length > 0
        ? `<div style="background:#fdecea;border:1px solid #d32f2f;border-radius:8px;padding:8px;margin-bottom:12px;color:#d32f2f;font-size:13px;">⚠ Prérequis non conformes : ${missing.join(', ')} — la mise sous tension (Date Début VPO) est bloquée jusqu'à ce que ce soit réglé.</div>`
        : (eq.details['Prérequis'] && eq.details['Prérequis'] !== '-' ? `<div style="color:#2e7d32;font-size:13px;margin-bottom:12px;">✓ Tous les prérequis sont conformes</div>` : '');

    let html = `
        <h3 class="room-title" style="line-height: 1.3;">
            PIÈCE ${roomNumber} <br>
            <span style="font-size: 0.65em; color: #7f8c8d;">${eq.nom}</span>
        </h3>
        ${prereqInfo}
        <button class="back-btn" onclick="showEquipments('${floor}','${roomNumber}')">⬅ Retour</button>
        <form id="inspectionForm" style="margin-top:20px;">
    `;

    for (const [propName, propValue] of Object.entries(eq.details)) {
        if (propName === 'Prérequis') continue;

        const safeProp = sanitizeId(propName);
        const firebaseSafeKey = sanitizeKey(propName);

        const prevStatus = eqSaved[firebaseSafeKey] ? eqSaved[firebaseSafeKey].etat : "";
        const prevComment = eqSaved[firebaseSafeKey] ? eqSaved[firebaseSafeKey].commentaire : "";

        // Seule "Date Début VPO" est bloquée par les prérequis - tout le reste reste libre
        const isEnergizedField = (propName === 'Date Début VPO');
        const isLocked = isEnergizedField && missing.length > 0;
        const disabledAttr = isLocked ? 'disabled' : '';
        const lockNote = isLocked
            ? `<div style="color:#d32f2f;font-size:11px;margin-top:2px;">🔒 Bloqué — manque: ${missing.join(', ')}</div>`
            : '';

        html += `
        <div class="equipment" style="${isLocked ? 'opacity:0.6;' : ''}">
          <strong>${propName} :</strong> ${propValue}
          <div class="radio-group-horizontal">
             <label class="radio-label"><input type="radio" name="etat_${safeProp}" value="C" ${prevStatus === 'C' ? 'checked' : ''} ${disabledAttr}> C</label>
             <label class="radio-label"><input type="radio" name="etat_${safeProp}" value="NC" ${prevStatus === 'NC' ? 'checked' : ''} ${disabledAttr}> NC</label>
             <label class="radio-label"><input type="radio" name="etat_${safeProp}" value="N/A" ${prevStatus === 'N/A' || prevStatus === 'NA' ? 'checked' : ''} ${disabledAttr}> N/A</label>
          </div>
          ${lockNote}
          <textarea id="comment_${safeProp}" placeholder="Notes..." ${isLocked ? 'disabled' : ''}>${prevComment}</textarea>
        </div>`;
    }

	html += `</form>
             <button class="save-btn" onclick="saveReport(event, '${floor}', '${roomNumber}', ${index})">
                 Enregistrer les données
             </button>
             <button class="delete-btn" onclick="deleteReport('${floor}', '${roomNumber}', ${index})" style="margin-top:15px;">
                 Supprimer les données
             </button>`;

    panel.innerHTML = html;
}

// ===== SAUVEGARDE RÉELLE =====
function saveReport(event, floor, room, eqIndex) {
    event.preventDefault();
    const btn = event.target;
    const eq = data[floor][room][eqIndex];
    const report = {};

    try {
        for (const [propName, propValue] of Object.entries(eq.details)) {
            if (propName === 'Prérequis') continue;

            const firebaseSafeKey = sanitizeKey(propName);
            const safeProp = sanitizeId(propName);
            let etat = "";
            const radios = document.getElementsByName(`etat_${safeProp}`);
            for (const radio of radios) { if (radio.checked) etat = radio.value; }

            const commentEl = document.getElementById(`comment_${safeProp}`);
            const commentaire = commentEl ? commentEl.value : "";

            report[firebaseSafeKey] = {
                nomOriginal: propName, valeur: propValue, etat: etat,
                commentaire: commentaire
            };
        }
    } catch (err) {
        console.error("Erreur pendant la construction du rapport:", err);
        alert("Erreur JS: " + err.message);
        return;
    }

    const finalSave = {
        meta: { niveau: floor, piece: room, equipement: eq.nom, date: new Date().toISOString() },
        details: report
    };

    const firebasePath = 'inspections/' + floor + '/' + room + '/' + sanitizeKey(eq.nom);

    if (isAppOnline && typeof firebase !== 'undefined') {
        const db = firebase.database();
        db.ref(firebasePath).set(finalSave).then(() => {
            let queue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
            queue = queue.filter(q => q.path !== firebasePath);
            localStorage.setItem('offlineQueue', JSON.stringify(queue));

            btn.textContent = "✓ Enregistré sur Cloud";
            btn.style.backgroundColor = "#27ae60";
            setTimeout(() => { btn.textContent = "Enregistrer"; btn.disabled = false; }, 2000);
        }).catch((err) => {
            console.error("Erreur Firebase:", err);
            saveToOffline(firebasePath, finalSave, btn);
        });
    } else {
        saveToOffline(firebasePath, finalSave, btn);
    }
}

function saveToOffline(path, data, btn) {
    let queue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
    queue = queue.filter(q => q.path !== path); 
    queue.push({ path: path, data: data });
    localStorage.setItem('offlineQueue', JSON.stringify(queue));

    btn.textContent = "💾 Sauvegardé en local";
    btn.style.backgroundColor = "#e67e22";
    setTimeout(() => { btn.textContent = "Enregistrer"; btn.disabled = false; }, 2000);
}

// ===== EXPORT PDF =====
function exportToPDF() {
    const btn = document.querySelector('button[onclick="exportToPDF()"]');
    if(btn) btn.innerHTML = "⏳ Préparation...";

    let allData = JSON.parse(localStorage.getItem('all_inspections')) || {};
    const offlineQueue = JSON.parse(localStorage.getItem('offlineQueue')) || [];
    
    offlineQueue.forEach(item => {
        const parts = item.path.split('/');
        const lvl = parts[1];
        const rm = parts[2];
        const eqName = parts[3];
        
        if (!allData[lvl]) allData[lvl] = {};
        if (!allData[lvl][rm]) allData[lvl][rm] = {};
        allData[lvl][rm][eqName] = item.data;
    });

	const groups = [];

    for (const [floor, rooms] of Object.entries(allData)) {
        for (const [room, equipments] of Object.entries(rooms)) {
            for (const [eqName, dataSaved] of Object.entries(equipments)) {

                const equipLabel = dataSaved.meta?.equipement || eqName;
                const location = `Salle ${dataSaved.meta?.piece || room}`;

                if (dataSaved.meta && dataSaved.details) {
                    const rows = [];
                    for (const [propKey, propData] of Object.entries(dataSaved.details)) {
                        rows.push([
                            propData.nomOriginal || propKey,
                            propData.etat || "-",
                            propData.commentaire || ""
                        ]);
                    }
                    groups.push({ location, equipLabel, rows });
                }
            }
        }
    }

    groups.sort((a, b) => a.location.localeCompare(b.location));

    const tableBody = [];
    groups.forEach(group => {
        group.rows.forEach((row, idx) => {
            tableBody.push([
                idx === 0 ? group.location : "",
                idx === 0 ? group.equipLabel : "",
                ...row
            ]);
        });
    });

    if (tableBody.length === 0) {
        alert("Aucune donnée disponible pour générer le rapport.");
        if(btn) btn.innerHTML = "📄 Exporter Rapport PDF";
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.text("Rapport d'Inspection d'Équipement", 14, 20);

    doc.autoTable({
        head: [['Localisation', 'Équipement', 'Point de contrôle', 'Statut', 'Commentaire']],
        body: tableBody,
        startY: 30,
        theme: 'grid',
        headStyles: { fillColor: [44, 62, 80] }, 
        styles: { fontSize: 8 }
    });

    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        const blob = doc.output('blob');
        window.open(URL.createObjectURL(blob), '_blank');
    } else {
        doc.save(`Inspection_${new Date().toISOString().slice(0,10)}.pdf`);
    }
    
    if(btn) btn.innerHTML = "📄 Exporter Rapport PDF";
}

// ===== DELETE INFO =====
function deleteReport(floor, room, eqIndex) {
    const eq = data[floor][room][eqIndex];
    const safeEqName = sanitizeKey(eq.nom);
    const firebasePath = 'inspections/' + floor + '/' + room + '/' + safeEqName;

    // Fenêtre de confirmation
    if (confirm("Êtes-vous sûr de vouloir supprimer l'information de l'équipement ?")) {
        
        // 1. Supprimer de Firebase
        if (typeof firebase !== 'undefined' && navigator.onLine) {
            firebase.database().ref(firebasePath).remove()
                .then(() => {
                    // 2. Nettoyer le cache local
                    let allInspections = JSON.parse(localStorage.getItem('all_inspections')) || {};
                    if (allInspections[floor] && allInspections[floor][room]) {
                        delete allInspections[floor][room][safeEqName];
                        localStorage.setItem('all_inspections', JSON.stringify(allInspections));
                    }
                    
                    alert("Données supprimées avec succès.");
                    showEquipments(floor, room); // Retour à la liste
                })
                .catch((error) => alert("Erreur lors de la suppression : " + error.message));
        } else {
            alert("Vous devez être en ligne pour supprimer les données du Cloud.");
        }
    }
}
