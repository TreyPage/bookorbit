export type SeriesNameCandidate = {
  id: number;
  name: string;
  bookCount: number;
};

export type SeriesNameCandidatePair = {
  left: SeriesNameCandidate;
  right: SeriesNameCandidate;
  similarity: number;
};

export type SeriesNameCandidatesResult = {
  items: SeriesNameCandidatePair[];
  truncated: boolean;
};

export type MergeSeriesResult = {
  targetSeriesId: number;
  mergedSeriesIds: number[];
  movedMemberships: number;
  duplicateMembershipsRemoved: number;
};
