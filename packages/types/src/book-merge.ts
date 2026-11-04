export interface BookMergeCandidateBook {
  id: number;
  title: string | null;
  authors: string[];
  formats: string[];
  folderPath: string;
  libraryName: string;
}

export interface BookMergeCandidatePair {
  bookIdA: number;
  bookIdB: number;
  titleSimilarity: number;
  books: [BookMergeCandidateBook, BookMergeCandidateBook];
}

export interface BookMergeCandidateCursor {
  bookIdA: number;
  bookIdB: number;
}

export interface BookMergeCandidatePage {
  candidates: BookMergeCandidatePair[];
  nextCursor: BookMergeCandidateCursor | null;
}
