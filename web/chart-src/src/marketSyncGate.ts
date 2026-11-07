export interface MarketSyncGateJob { job_id: string; status: string }

/** A first page is not proof that the four-period sync task has finished. */
export function syncChartReady(checked: boolean, job: MarketSyncGateJob | null, acknowledged: string | null): boolean {
  if (!checked) return false;
  if (!job) return true;
  if (job.status === 'waiting' || job.status === 'running') return false;
  if (job.status === 'partial' || job.status === 'error') return acknowledged === job.job_id;
  return job.status === 'completed' || job.status === 'cancelled';
}
