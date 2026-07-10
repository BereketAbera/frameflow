import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/db/migrate.js";
import { SocialRepository } from "../src/db/social-repository.js";

type FeaturedFilm = {
  title: string;
  creator: string;
  sourceUrl: string;
  embedUrl: string;
  thumbnailUrl: string;
};

describe("curated AI films", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("contains ten unique direct films with real artwork and attribution", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "curation-"));
    const databasePath = path.join(root, "app.db");
    await migrateDatabase(databasePath);
    const repository = new SocialRepository(databasePath);
    const films = repository.featured() as FeaturedFilm[];
    repository.close();

    expect(films).toHaveLength(10);
    expect(new Set(films.map((film) => film.sourceUrl)).size).toBe(10);

    for (const film of films) {
      expect(film.title).toBeTruthy();
      expect(film.creator).toBeTruthy();
      expect(film.title.toLowerCase()).not.toContain("tutorial");
      expect(film.sourceUrl).toMatch(
        /^https:\/\/(?:www\.youtube\.com\/watch\?v=|vimeo\.com\/\d+)/,
      );
      expect(film.sourceUrl).not.toMatch(/aif\.runwayml\.com|labs\.google|hollywood\.ai/);
      expect(film.embedUrl).toMatch(
        /^https:\/\/(?:www\.youtube\.com\/embed\/|player\.vimeo\.com\/video\/)/,
      );
      expect(film.thumbnailUrl).toMatch(
        /^https:\/\/(?:i\.ytimg\.com|img\.youtube\.com|i\.vimeocdn\.com)\//,
      );
    }
  });
});
