import { EventEmitter } from 'events';

export class Scheduler extends EventEmitter {
  constructor() {
    this.jobs = [];
    this.timers = new Map();
  }

  addJob(job) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: job.type,          // 'token_buy', 'nft_mint', 'sell'
      chain: job.chain,
      target: job.target,       // token/contract address
      scheduledTime: job.scheduledTime,
      params: job.params || {},
      status: 'scheduled',
      label: job.label || `${job.type}@${new Date(job.scheduledTime).toLocaleTimeString()}`,
      createdAt: new Date().toISOString()
    };

    this.jobs.push(entry);

    const delay = new Date(entry.scheduledTime).getTime() - Date.now();
    if (delay > 0) {
      const timer = setTimeout(() => {
        entry.status = 'firing';
        this.emit('job-fire', entry);
        this.timers.delete(entry.id);
      }, delay);
      this.timers.set(entry.id, timer);

      console.log(`[Scheduler] Job ${entry.id} (${entry.type}) fires in ${Math.round(delay / 1000)}s`);
    } else {
      entry.status = 'firing';
      this.emit('job-fire', entry);
    }

    this.emit('job-added', entry);
    return entry;
  }

  cancelJob(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return false;

    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    job.status = 'cancelled';
    this.emit('job-cancelled', job);
    return true;
  }

  getJobs(status) {
    if (status) return this.jobs.filter(j => j.status === status);
    return this.jobs;
  }

  getUpcoming() {
    const now = Date.now();
    return this.jobs
      .filter(j => j.status === 'scheduled' && new Date(j.scheduledTime).getTime() > now)
      .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
  }

  clearCompleted() {
    this.jobs = this.jobs.filter(j => j.status === 'scheduled' || j.status === 'firing');
  }

  cancelAll() {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.jobs.forEach(j => {
      if (j.status === 'scheduled') j.status = 'cancelled';
    });
    this.emit('all-cancelled', {});
  }
}
