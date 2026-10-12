import fs from 'fs';
import path from 'path';

export class UserManager {
  constructor(options = {}) {
    this.usersFile = options.usersFile || path.resolve(process.cwd(), 'users.json');
    this.users = new Map(); // id -> user
    this.loadUsers();
  }

  loadUsers() {
    try {
      if (fs.existsSync(this.usersFile)) {
        const raw = fs.readFileSync(this.usersFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.users)) {
          for (const u of parsed.users) {
            this.users.set(u.id, u);
          }
        }
      }
    } catch (err) {
      console.warn('[UserManager] Could not read users.json:', err.message);
    }
  }

  saveUsers() {
    try {
      const payload = {
        users: Array.from(this.users.values())
      };
      fs.writeFileSync(this.usersFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.error('[UserManager] Failed to save users.json:', err.message);
    }
  }

  getUserById(id) {
    if (!id) return null;
    return this.users.get(id) || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    for (const u of this.users.values()) {
      if (u.email && u.email.toLowerCase().trim() === clean) {
        return u;
      }
    }
    return null;
  }

  getAllUsers() {
    return Array.from(this.users.values()).map(u => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      role: u.role,
      status: u.status,
      authProvider: u.authProvider,
      quota: u.quota,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    }));
  }

  /**
   * Handle Google OAuth Sign-In or Sign-Up
   */
  handleGoogleUser({ sub, email, name, picture }, authConfig = {}) {
    if (!email) throw new Error('Email address is required from Google account');
    const cleanEmail = email.toLowerCase().trim();

    // Check admin email list
    const adminEmails = (authConfig.adminEmails || []).map(e => e.toLowerCase().trim());
    const isExplicitAdmin = adminEmails.includes(cleanEmail);

    // If server has zero users, first Google user automatically becomes Master Admin
    const isFirstUser = this.users.size === 0;

    // Check domain / email whitelists
    const allowedEmails = (authConfig.allowedEmails || []).map(e => e.toLowerCase().trim());
    const allowedDomains = (authConfig.allowedDomains || []).map(d => d.toLowerCase().trim());
    const domain = cleanEmail.split('@')[1] || '';

    if (!isExplicitAdmin && !isFirstUser) {
      if (allowedEmails.length > 0 && !allowedEmails.includes(cleanEmail)) {
        throw new Error('Access denied: Your email is not on the authorized user list.');
      }
      if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
        throw new Error(`Access denied: Google accounts from @${domain} are not permitted.`);
      }
    }

    const defaultQuota = authConfig.defaultUserQuota || {
      maxActiveTorrents: 3,
      maxStorageBytes: 21474836480, // 20 GB
      maxTorrentSizeBytes: 10737418240 // 10 GB
    };

    let user = this.getUserByEmail(cleanEmail);

    if (user) {
      if (user.status === 'banned') {
        throw new Error('Your account has been deactivated by the server administrator.');
      }

      // Update profile info
      user.name = name || user.name;
      user.picture = picture || user.picture;
      user.lastLogin = Date.now();
      if (isExplicitAdmin) {
        user.role = 'admin';
      }
      this.users.set(user.id, user);
      this.saveUsers();
      return user;
    }

    // Create New User
    const newUserId = `usr_${sub || Math.random().toString(36).substring(2, 12)}`;
    const assignedRole = (isExplicitAdmin || isFirstUser) ? 'admin' : 'user';

    user = {
      id: newUserId,
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      picture: picture || null,
      role: assignedRole,
      status: 'active',
      authProvider: 'google',
      quota: { ...defaultQuota },
      createdAt: Date.now(),
      lastLogin: Date.now()
    };

    this.users.set(newUserId, user);
    this.saveUsers();
    console.log(`[UserManager] New user registered via Google: ${cleanEmail} (${assignedRole})`);
    return user;
  }

  updateUserRole(userId, newRole) {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    if (newRole !== 'admin' && newRole !== 'user') throw new Error('Invalid role');
    user.role = newRole;
    this.saveUsers();
    return user;
  }

  updateUserQuota(userId, newQuota) {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    user.quota = { ...user.quota, ...newQuota };
    this.saveUsers();
    return user;
  }

  setUserStatus(userId, status) {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');
    if (status !== 'active' && status !== 'banned') throw new Error('Invalid status');
    user.status = status;
    this.saveUsers();
    return user;
  }

  deleteUser(userId) {
    if (!this.users.has(userId)) throw new Error('User not found');
    this.users.delete(userId);
    this.saveUsers();
    return true;
  }

  /**
   * Calculate current user storage and active torrent usage
   */
  getUserUsage(userId, torrentsStateList = []) {
    let activeTorrents = 0;
    let totalStorageBytes = 0;

    for (const t of torrentsStateList) {
      if (t.ownerId === userId) {
        if (t.status === 'downloading') {
          activeTorrents++;
        }
        totalStorageBytes += (t.downloaded || t.length || 0);
      }
    }

    return {
      activeTorrents,
      totalStorageBytes
    };
  }
}

export default new UserManager();
