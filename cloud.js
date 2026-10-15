/* Connexion sécurisée Gestion Awalé — Supabase JS v2 */
(function () {
  'use strict';
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    const status = document.getElementById('syncStatus'); if (status) status.textContent = 'Service de connexion indisponible';
    const feedback = document.getElementById('authFeedback'); if (feedback) feedback.textContent = 'Le module sécurisé ne se charge pas. Vérifie la connexion Internet et recharge la page.';
    return;
  }
  const SUPABASE_URL = 'https://pbdokxbxuvjvvufuacws.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BjYlPsrj4yyueccDRPjT8Q_KrCNOqzm';
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'gestion-awale-auth-v5' }
  });
  let cloudReady = false, cloudLoading = false, cloudSaving = false, schoolId = '', schoolRow = null;
  let schoolYearId = '', activeYearLabel = '2026–2027', termIds = {}, termNoById = {};
  let knownTeacherIds = new Set(), knownSubjectIds = new Set(), knownStudentIds = new Set();
  let gradeRowsByKey = new Map(), attendanceSessionsByKey = new Map(), attendanceEntryIdsByKey = new Map();
  let enrollmentByStudent = new Map(), realtimeChannel = null, refreshTimer = null;
  let writeQueue = Promise.resolve(), lastLocalWrite = 0;
  const currentYearDefault = '2026–2027';
  const byId = id => document.getElementById(id);
  const makeId = () => crypto.randomUUID();
  const setStatus = text => { const el = byId('syncStatus'); if (el) el.textContent = text; };
  const showGateMessage = text => { const el = byId('authFeedback'); if (el) el.textContent = text; };
  const safeMessage = error => {
    const m = String(error && error.message || '');
    if (/fetch|network|failed to/i.test(m)) return 'Connexion internet indisponible. Vérifie le réseau et réessaie.';
    if (/invalid|expired|otp|token/i.test(m)) return 'Le code est incorrect ou expiré. Demande un nouveau code.';
    if (/permission|denied|row-level|not allowed/i.test(m)) return 'L’accès sécurisé à la base n’est pas encore prêt. Aucune donnée n’a été modifiée.';
    return 'Une erreur est survenue. Réessaie dans un instant.';
  };
  async function result(query, label) {
    const { data, error } = await query;
    if (error) throw new Error((label ? label + ': ' : '') + error.message);
    return data || [];
  }
  async function one(query, label) {
    const { data, error } = await query;
    if (error) throw new Error((label ? label + ': ' : '') + error.message);
    return data;
  }
  function showAuthGate(show) { const gate = byId('authGate'); if (gate) gate.hidden = !show; }
  function syncField(key, value) { const form = byId('settingsForm'); if (form && form.elements[key]) form.elements[key].value = value || ''; }

  async function loadCloudState() {
    const school = await one(db.from('schools').select('*').limit(1).single(), 'Établissement');
    schoolRow = school; schoolId = school.id;
    activeYearLabel = school.settings && school.settings.active_year || currentYearDefault;
    const years = await result(db.from('school_years').select('*').eq('school_id', schoolId).order('label'), 'Années scolaires');
    const year = years.find(y => y.label === activeYearLabel) || years[0];
    if (!year) throw new Error('Aucune année scolaire préparée dans la base.');
    schoolYearId = year.id; activeYearLabel = year.label;
    const [terms, classes, enrollments, rawStudents, teachers, subjects, assignments, rawGrades, sessions] = await Promise.all([
      result(db.from('terms').select('*').eq('school_year_id', schoolYearId).order('term_no'), 'Trimestres'),
      result(db.from('classes').select('*').eq('school_year_id', schoolYearId).order('label'), 'Classes'),
      result(db.from('enrollments').select('*').eq('school_year_id', schoolYearId), 'Inscriptions'),
      result(db.from('students').select('*').eq('school_id', schoolId).order('last_name'), 'Élèves'),
      result(db.from('teachers').select('*').eq('school_id', schoolId).order('last_name'), 'Professeurs'),
      result(db.from('subjects').select('*').eq('school_id', schoolId).order('name'), 'Matières'),
      result(db.from('teacher_assignments').select('*').eq('school_id', schoolId), 'Attributions'),
      result(db.from('student_grades').select('*').eq('school_id', schoolId), 'Moyennes'),
      result(db.from('attendance_sessions').select('*').eq('school_id', schoolId), 'Appels')
    ]);
    termIds = {}; termNoById = {};
    terms.forEach(t => { termIds[String(t.term_no)] = t.id; termNoById[t.id] = String(t.term_no); });
    if (!terms.length) throw new Error('Les trimestres ne sont pas configurés.');
    const classMap = new Map(classes.map(c => [c.id, c]));
    enrollmentByStudent = new Map(enrollments.map(e => [e.student_id, e]));
    const enrollmentsById = new Map(enrollments.map(e => [e.id, e]));
    const teacherById = new Map(teachers.map(t => [t.id, t]));
    const assignmentBySubject = new Map();
    assignments.filter(a => classMap.has(a.class_id)).forEach(a => { if (!assignmentBySubject.has(a.subject_id)) assignmentBySubject.set(a.subject_id, a.teacher_id); });
    const scopedSubjects = subjects.filter(s => classMap.has(s.class_id));
    const scopedAssignments = assignments.filter(a => classMap.has(a.class_id));
    const subjectById = new Map(scopedSubjects.map(s => [s.id, s]));
    state = {
      settings: {
        school: school.name || '', address: school.address || '', phone: school.phone || '',
        code: school.establishment_code || '', schoolStatus: school.establishment_status || '',
        year: activeYearLabel, adminPhone: school.admin_phone || '', adminEmail: school.admin_email || '',
        term: String(school.settings && school.settings.active_term || 1)
      },
      classes: classes.map(c => ({ id: c.id, label: c.label, group: c.group_name })),
      students: [], teachers: [], subjects: [], attendance: {}, grades: {}
    };
    selectedTerm = state.settings.term;
    state.students = rawStudents.map(s => {
      const e = enrollmentByStudent.get(s.id);
      return e && classMap.has(e.class_id) ? {
        id: s.id, enrollmentId: e.id, matricule: s.matricule, last: s.last_name, first: s.first_names,
        classId: e.class_id, sex: s.sex || '', dob: s.date_of_birth || '', birthplace: s.birth_place || '',
        assignment: s.assignment_status || '', photoPath: s.photo_path || '', photo: ''
      } : null;
    }).filter(Boolean);
    for (const s of state.students) {
      if (s.photoPath) {
        try { const { data, error } = await db.storage.from('student-photos').createSignedUrl(s.photoPath, 3600); if (!error && data) s.photo = data.signedUrl; }
        catch (_) { /* A missing photo does not prevent opening the student record. */ }
      }
    }
    state.subjects = scopedSubjects.map(s => ({
      id: s.id, classId: s.class_id, name: s.name, coefficient: Number(s.coefficient), category: s.category || 'Autres',
      teacherId: assignmentBySubject.get(s.id) || ''
    }));
    state.teachers = teachers.map(t => {
      const related = scopedAssignments.filter(a => a.teacher_id === t.id);
      const names = related.map(a => { const sub = subjectById.get(a.subject_id); const cls = classMap.get(a.class_id); return sub && cls ? `${sub.name} — ${cls.label}` : ''; }).filter(Boolean);
      return { id: t.id, last: t.last_name, first: t.first_names, phone: t.phone || '', subjectNames: names.join(', '), classIds: [...new Set(related.map(a => a.class_id))] };
    });
    knownTeacherIds = new Set(teachers.map(t => t.id));
    knownSubjectIds = new Set(scopedSubjects.map(s => s.id));
    knownStudentIds = new Set(state.students.map(s => s.id));
    const enrollmentById = new Map(enrollments.map(e => [e.id, e]));
    gradeRowsByKey = new Map();
    rawGrades.forEach(g => {
      const en = enrollmentById.get(g.enrollment_id), no = termNoById[g.term_id];
      if (!en || !no || g.mean === null) return;
      const key = `${g.term_id}|${g.enrollment_id}|${g.subject_id}`;
      gradeRowsByKey.set(key, g.id);
      const sub = subjectById.get(g.subject_id);
      if (!sub) return;
      const stateKey = `${no}|${en.class_id}`;
      state.grades[stateKey] = state.grades[stateKey] || {};
      state.grades[stateKey][en.student_id] = state.grades[stateKey][en.student_id] || {};
      state.grades[stateKey][en.student_id][g.subject_id] = Number(g.mean);
    });
    const currentTermIds = new Set(terms.map(t => t.id));
    const currentSessions = sessions.filter(s => currentTermIds.has(s.term_id) && classMap.has(s.class_id));
    attendanceSessionsByKey = new Map();
    currentSessions.forEach(s => {
      const key = `${s.class_id}|${s.attended_on}`;
      attendanceSessionsByKey.set(key, s.id);
      state.attendance[key] = { _term: String(termNoById[s.term_id] || 1) };
    });
    const sessionById = new Map(currentSessions.map(s => [s.id, s]));
    const sessionIds = [...sessionById.keys()];
    attendanceEntryIdsByKey = new Map();
    if (sessionIds.length) {
      const entries = await result(db.from('attendance_entries').select('*').eq('school_id', schoolId).in('session_id', sessionIds), 'Données d’appel');
      entries.forEach(r => {
        const sess = sessionById.get(r.session_id), en = enrollmentById.get(r.enrollment_id);
        if (!sess || !en) return;
        const key = `${sess.class_id}|${sess.attended_on}`;
        const entryKey = `${sess.id}|${r.enrollment_id}`;
        attendanceEntryIdsByKey.set(entryKey, r.id);
        state.attendance[key] = state.attendance[key] || { _term: String(termNoById[sess.term_id] || 1) };
        state.attendance[key][en.student_id] = {
          status: r.status, justified: r.justification === 'Justifiée' ? 'yes' : r.justification === 'Non justifiée' ? 'no' : '',
          reason: r.reason || '', _entryId: r.id
        };
      });
    }
    syncField('school', state.settings.school); syncField('address', state.settings.address); syncField('phone', state.settings.phone);
    syncField('code', state.settings.code); syncField('schoolStatus', state.settings.schoolStatus);
    syncField('year', state.settings.year); syncField('term', state.settings.term);
    syncField('adminPhone', state.settings.adminPhone); syncField('adminEmail', state.settings.adminEmail);
  }

  async function openCloudSession() {
    if (cloudLoading || cloudReady) return;
    cloudLoading = true; setStatus('Chargement…');
    try {
      await loadCloudState();
      cloudReady = true; showAuthGate(false); setStatus('Synchronisé');
      byId('cloudUser').textContent = (await db.auth.getUser()).data.user?.email || '';
      byId('cloudUser').hidden = false; byId('signOut').hidden = false;
      render(); subscribeRealtime();
    } catch (error) {
      console.error('Gestion Awalé cloud load:', error);
      showAuthGate(true); setStatus('Connexion à vérifier');
      showGateMessage('La connexion est ouverte, mais la base n’a pas pu être chargée. Vérifie le réseau puis réessaie. N’ajoute pas encore de données.');
    } finally { cloudLoading = false; }
  }

  function subscribeRealtime() {
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    const tables = ['schools','school_years','terms','classes','students','enrollments','teachers','subjects','teacher_assignments','attendance_sessions','attendance_entries','student_grades'];
    realtimeChannel = db.channel('gestion-awale-live');
    tables.forEach(table => realtimeChannel.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
      if (Date.now() - lastLocalWrite < 1600 || cloudSaving) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        if (!cloudReady || cloudSaving) return;
        try { await loadCloudState(); render(); setStatus('Synchronisé'); }
        catch (e) { console.error('Gestion Awalé refresh:', e); setStatus('Réseau à vérifier'); }
      }, 900);
    }));
    realtimeChannel.subscribe(status => {
      if (status === 'SUBSCRIBED') setStatus('Synchronisé · temps réel actif');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setStatus('Connecté · temps réel indisponible');
    });
  }

  async function persistCloudState() {
    if (!cloudReady || cloudSaving) return;
    cloudSaving = true; setStatus('Enregistrement…');
    try {
      const settings = state.settings || {};
      const activeTerm = Number(settings.term || 1);
      const { error: schoolError } = await db.from('schools').update({
        name: settings.school, address: settings.address || null, phone: settings.phone || null,
        admin_email: settings.adminEmail || null, admin_phone: settings.adminPhone || null,
        establishment_code: settings.code || null, establishment_status: settings.schoolStatus || null,
        settings: { ...(schoolRow.settings || {}), active_year: activeYearLabel, active_term: activeTerm }
      }).eq('id', schoolId);
      if (schoolError) throw schoolError;
      if (state.classes.length) {
        const rows = state.classes.map(c => ({ id: c.id, school_id: schoolId, school_year_id: schoolYearId, label: c.label, group_name: c.group || 'Groupe 1' }));
        const { error } = await db.from('classes').upsert(rows, { onConflict: 'id' }); if (error) throw error;
      }
      const currentClassIds = new Set(state.classes.map(c => c.id));
      const currentTeacherIds = new Set(state.teachers.map(t => t.id));
      const currentSubjectIds = new Set(state.subjects.map(s => s.id));
      const studentRows = [];
      for (const s of state.students) {
        if (s.photo && s.photo.startsWith('data:image/')) {
          const blob = await (await fetch(s.photo)).blob();
          const path = `${schoolId}/${s.id}/photo.jpg`;
          const { error: uploadError } = await db.storage.from('student-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
          if (uploadError) throw uploadError;
          s.photoPath = path;
          const { data: signed } = await db.storage.from('student-photos').createSignedUrl(path, 3600);
          s.photo = signed?.signedUrl || '';
        }
        studentRows.push({ id: s.id, school_id: schoolId, matricule: s.matricule, last_name: s.last, first_names: s.first,
          sex: s.sex || null, date_of_birth: s.dob || null, birth_place: s.birthplace || null,
          assignment_status: s.assignment || null, photo_path: s.photoPath || null });
      }
      if (studentRows.length) { const { error } = await db.from('students').upsert(studentRows, { onConflict: 'id' }); if (error) throw error; }
      const enrollmentRows = state.students.map(s => {
        if (!s.enrollmentId) s.enrollmentId = makeId();
        enrollmentByStudent.set(s.id, { id: s.enrollmentId, student_id: s.id, class_id: s.classId, school_id: schoolId, school_year_id: schoolYearId });
        return { id: s.enrollmentId, school_id: schoolId, student_id: s.id, school_year_id: schoolYearId, class_id: s.classId };
      });
      if (enrollmentRows.length) { const { error } = await db.from('enrollments').upsert(enrollmentRows, { onConflict: 'id' }); if (error) throw error; }
      const currentStudentIds = new Set(state.students.map(s => s.id));
      const removedStudentIds = [...knownStudentIds].filter(id => !currentStudentIds.has(id));
      if (removedStudentIds.length) {
        const removedStudents = await result(db.from('students').select('id,photo_path').eq('school_id', schoolId).in('id', removedStudentIds), 'Élèves à supprimer');
        const photoPaths = removedStudents.map(s => s.photo_path).filter(Boolean);
        if (photoPaths.length) { const { error } = await db.storage.from('student-photos').remove(photoPaths); if (error) throw error; }
        const { error } = await db.from('students').delete().eq('school_id', schoolId).in('id', removedStudentIds); if (error) throw error;
      }
      knownStudentIds = currentStudentIds;
      const teacherRows = state.teachers.map(t => ({ id: t.id, school_id: schoolId, last_name: t.last, first_names: t.first, phone: t.phone || null }));
      if (teacherRows.length) { const { error } = await db.from('teachers').upsert(teacherRows, { onConflict: 'id' }); if (error) throw error; }
      const subjectRows = state.subjects.map(s => ({ id: s.id, school_id: schoolId, class_id: s.classId, name: s.name, coefficient: Number(s.coefficient), category: s.category || 'Autres' }));
      if (subjectRows.length) { const { error } = await db.from('subjects').upsert(subjectRows, { onConflict: 'id' }); if (error) throw error; }
      if (currentClassIds.size) { const { error: assignmentDeleteError } = await db.from('teacher_assignments').delete().eq('school_id', schoolId).in('class_id', [...currentClassIds]); if (assignmentDeleteError) throw assignmentDeleteError; }
      const assignmentRows = state.subjects.filter(s => s.teacherId && currentTeacherIds.has(s.teacherId)).map(s => ({
        school_id: schoolId, teacher_id: s.teacherId, class_id: s.classId, subject_id: s.id
      }));
      if (assignmentRows.length) { const { error } = await db.from('teacher_assignments').insert(assignmentRows); if (error) throw error; }
      const removedSubjects = [...knownSubjectIds].filter(id => !currentSubjectIds.has(id));
      if (removedSubjects.length) { const { error } = await db.from('subjects').delete().in('id', removedSubjects); if (error) throw error; }
      const removedTeachers = [...knownTeacherIds].filter(id => !currentTeacherIds.has(id));
      if (removedTeachers.length) { const { error } = await db.from('teachers').delete().in('id', removedTeachers); if (error) throw error; }
      knownTeacherIds = currentTeacherIds; knownSubjectIds = currentSubjectIds;
      const desiredGrades = new Map();
      for (const [stateKey, byStudent] of Object.entries(state.grades || {})) {
        const [termNo, classId] = stateKey.split('|'), termId = termIds[String(termNo)];
        if (!termId || !currentClassIds.has(classId)) continue;
        for (const [studentId, bySubject] of Object.entries(byStudent || {})) {
          const en = enrollmentByStudent.get(studentId); if (!en || !currentStudentIds.has(studentId)) continue;
          for (const [subjectId, raw] of Object.entries(bySubject || {})) {
            if (raw === '' || raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
            const key = `${termId}|${en.id}|${subjectId}`;
            const id = gradeRowsByKey.get(key) || makeId();
            desiredGrades.set(key, { id, school_id: schoolId, term_id: termId, enrollment_id: en.id, subject_id: subjectId, mean: Number(raw) });
          }
        }
      }
      const removedGradeIds = [...gradeRowsByKey.entries()].filter(([key]) => !desiredGrades.has(key)).map(([, id]) => id);
      if (removedGradeIds.length) { const { error } = await db.from('student_grades').delete().in('id', removedGradeIds); if (error) throw error; }
      const gradeRows = [...desiredGrades.values()];
      if (gradeRows.length) { const { error } = await db.from('student_grades').upsert(gradeRows, { onConflict: 'id' }); if (error) throw error; }
      gradeRowsByKey = new Map([...desiredGrades.entries()].map(([key, row]) => [key, row.id]));
      const desiredSessions = [];
      const desiredEntries = [];
      for (const [key, records] of Object.entries(state.attendance || {})) {
        const [classId, date] = key.split('|'), termId = termIds[String(records._term || activeTerm)];
        if (!termId || !currentClassIds.has(classId)) continue;
        const sessionId = attendanceSessionsByKey.get(key) || makeId();
        attendanceSessionsByKey.set(key, sessionId);
        desiredSessions.push({ id: sessionId, school_id: schoolId, class_id: classId, term_id: termId, attended_on: date });
        for (const [studentId, record] of Object.entries(records)) {
          if (studentId === '_term' || !record || !record.status) continue;
          const en = enrollmentByStudent.get(studentId); if (!en || !currentStudentIds.has(studentId)) continue;
          const entryKey = `${sessionId}|${en.id}`;
          const entryId = record._entryId || attendanceEntryIdsByKey.get(entryKey) || makeId();
          record._entryId = entryId; attendanceEntryIdsByKey.set(entryKey, entryId);
          desiredEntries.push({ id: entryId, school_id: schoolId, session_id: sessionId, class_id: classId,
            enrollment_id: en.id, status: record.status,
            justification: record.status === 'Absent' ? (record.justified === 'yes' ? 'Justifiée' : record.justified === 'no' ? 'Non justifiée' : null) : null,
            reason: record.reason || null });
        }
      }
      if (desiredSessions.length) { const { error } = await db.from('attendance_sessions').upsert(desiredSessions, { onConflict: 'id' }); if (error) throw error; }
      if (desiredEntries.length) { const { error } = await db.from('attendance_entries').upsert(desiredEntries, { onConflict: 'id' }); if (error) throw error; }
      schoolRow = { ...schoolRow, name: settings.school, address: settings.address, phone: settings.phone,
        admin_email: settings.adminEmail, admin_phone: settings.adminPhone, establishment_code: settings.code,
        establishment_status: settings.schoolStatus, settings: { ...(schoolRow.settings || {}), active_year: activeYearLabel, active_term: activeTerm } };
      lastLocalWrite = Date.now(); setStatus('Synchronisé');
    } catch (error) {
      console.error('Gestion Awalé cloud save:', error); setStatus('Erreur de synchronisation');
      throw error;
    } finally { cloudSaving = false; }
  }

  // Replace the prototype's localStorage save with a queued, authenticated cloud save.
  window.__cloudSave = function () {
    if (!cloudReady) return Promise.resolve();
    writeQueue = writeQueue.then(() => persistCloudState()).catch(error => {
      console.error('Gestion Awalé save queue:', error);
      alert('La synchronisation a échoué. Certaines modifications peuvent déjà avoir été enregistrées. Vérifie le statut, recharge les données distantes avant de réessayer et ne saisis aucune donnée réelle pendant le test.');
    });
    return writeQueue;
  };

  window.__exportBackup = function () {
    const payload = { format: 'gestion-awale-backup-v5', version: 5, schoolId, exportedAt: new Date().toISOString(), state: JSON.parse(JSON.stringify(state)) };
    payload.state.students = payload.state.students.map(s => ({ ...s, photo: '', photoPath: s.photoPath || '' }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gestion-awale-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  window.__importBackup = function () { alert('La restauration est désactivée dans cette version afin de protéger les données en ligne.'); };

  async function requestCode(event) {
    event.preventDefault();
    const email = String(byId('loginEmail').value || '').trim().toLowerCase();
    if (!email) return;
    const button = byId('sendCode'); button.disabled = true; showGateMessage('Envoi du lien sécurisé…');
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const { error } = await db.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
      if (error) throw error;
      showGateMessage('Lien envoyé. Ouvre-le dans ce même navigateur pour accéder à Gestion Awalé.');
    } catch (error) { showGateMessage(safeMessage(error)); }
    finally { button.disabled = false; }
  }
  async function signOut() {
    if (!confirm('Te déconnecter de Gestion Awalé sur cet appareil ?')) return;
    await db.auth.signOut(); cloudReady = false; state = defaults(); showAuthGate(true); setStatus('Déconnecté');
    byId('cloudUser').hidden = true; byId('signOut').hidden = true;
    byId('emailStep').hidden = false; showGateMessage('Saisis ton adresse e-mail pour recevoir un lien de connexion.'); render();
  }
  async function initCloud() {
    state = defaults(); render(); showAuthGate(true); setStatus('Non connecté');
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      setStatus('Service de connexion indisponible');
      showGateMessage('Le module sécurisé ne se charge pas. Vérifie la connexion Internet et recharge la page.');
      return;
    }
    byId('emailForm').addEventListener('submit', requestCode);
    byId('signOut').addEventListener('click', signOut);
    db.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) setTimeout(openCloudSession, 0);
      if (event === 'SIGNED_OUT') { cloudReady = false; showAuthGate(true); setStatus('Déconnecté'); }
    });
    try {
      const { data, error } = await db.auth.getSession(); if (error) throw error;
      if (data.session) await openCloudSession();
    } catch (error) { console.error('Gestion Awalé auth startup:', error); showGateMessage('Connecte-toi avec ton adresse e-mail pour ouvrir les données privées.'); }
  }
  initCloud();
})();
