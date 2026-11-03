CREATE DATABASE IF NOT EXISTS lumpylp
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE lumpylp;

CREATE TABLE IF NOT EXISTS artists (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  source       ENUM('fma','jamendo','musopen') NOT NULL,
  bio          TEXT,
  artwork_url  VARCHAR(1024),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_artist_source (name, source),
  KEY idx_artist_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS genres (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(128) NOT NULL UNIQUE,
  track_count  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tracks (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  external_id      VARCHAR(128) NOT NULL,
  source           ENUM('fma','jamendo','musopen') NOT NULL,
  title            VARCHAR(512) NOT NULL,
  artist_name      VARCHAR(255) NOT NULL,
  genre            VARCHAR(128),
  duration_seconds INT,
  stream_url       VARCHAR(1024),
  download_url     VARCHAR(1024),
  license          VARCHAR(255),
  artwork_url      VARCHAR(1024),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  indexed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_track_source (external_id, source),
  KEY idx_track_genre (genre),
  KEY idx_track_artist (artist_name),
  FULLTEXT KEY ft_track_search (title, artist_name)
) ENGINE=InnoDB;
