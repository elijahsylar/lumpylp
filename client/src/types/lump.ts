import type { Track } from './track';

export interface UserLump {
  id: number;
  name: string;
  description: string | null;
  is_public: boolean;
  track_count: number;
  owner_username?: string;
  created_at: string;
  updated_at: string;
}

export interface LumpDetail {
  lump: UserLump;
  tracks: (Track & { position?: number })[];
  is_owner: boolean;
}
