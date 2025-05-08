import type {
  TeeviFeedCollection,
  TeeviFeedExtension,
  TeeviMetadataExtension,
  TeeviShow,
  TeeviShowEntry,
  TeeviShowEpisode,
  TeeviShowSeason,
  TeeviShowStatus,
  TeeviVideoAsset,
  TeeviVideoExtension,
} from "@teeviapp/core"
import { fetchVixcloudPlaylist } from "./utils/vixcloud"
import {
  AUShowStatus,
  fetchAUShow,
  fetchAUShowEpisodes,
  fetchAUShowsByQuery,
  fetchAUShowVideo,
} from "./api/au-api"
import { fetchJikanShow, fetchJikanShowEpisodes } from "./api/jikan-api"
import { fetchAnilistShow, fetchAnilistShowEpisodes } from "./api/anilist-api"

async function fetchShowsByQuery(query: string): Promise<TeeviShowEntry[]> {
  const shows = await fetchAUShowsByQuery(query)

  return shows.map((show) => {
    return {
      kind: show.type == "Movie" ? "movie" : "series",
      id: `${show.id}-${show.slug}`,
      title: show.title_eng,
      posterURL: show.imageurl,
      year: Number(show.date),
    } satisfies TeeviShowEntry
  })
}

async function fetchShow(id: string): Promise<TeeviShow> {
  const mapStatus = (auStatus?: AUShowStatus): TeeviShowStatus | undefined => {
    if (!auStatus) return undefined
    const status = auStatus.toLowerCase()
    if (status === "in corso") return "airing"
    if (status === "terminato") return "ended"
    if (status === "in uscita") return "upcoming"
    if (status === "droppato") return "canceled"
    return undefined
  }

  function createDateFromSeason(year: number, season?: string): string {
    const seasonToMonth: Record<string, number> = {
      Inverno: 0, // January
      Primavera: 3, // April
      Estate: 6, // July
      Autunno: 9, // October
    }

    const month = season ? seasonToMonth[season] ?? 0 : 0 // Default to January if season is undefined or invalid
    const date = new Date(year, month, 1) // Set the day to the 1st of the month
    return date.toISOString().split("T")[0] // Format as yyyy-mm-dd
  }

  const show = await fetchAUShow(id)
  const isSeries = show.type !== "Movie"

  let posterURL = show.imageurl
  let backdropURL = show.imageurl_cover
  let overview = show.plot || ""

  const parsedScore =
    typeof show.score === "string"
      ? parseFloat(show.score)
      : typeof show.score === "number"
      ? show.score
      : 0
  let rating: number = isNaN(parsedScore) ? 0 : parsedScore

  // Fetch additional data from MAL and Anilist

  if (show.mal_id) {
    try {
      const malShow = await fetchJikanShow(show.mal_id)
      const malPoster = malShow.images?.jpg?.large_image_url
      if (malPoster) {
        posterURL = malPoster
      }
      if (malShow.score && malShow.score > 0) {
        rating = malShow.score
      }
    } catch (error) {
      console.error(`Failed to fetch data from Jikan: ${error}`)
    }
  }

  if (show.anilist_id) {
    try {
      const aniShow = await fetchAnilistShow(show.anilist_id)
      if (aniShow.bannerImage) {
        backdropURL = aniShow.bannerImage
      }
    } catch (error) {
      console.error(`Failed to fetch data from Anilist: ${error}`)
    }
  }

  // Divide episodes into group of 100 for better performance
  const episodesCount = show.episodes_count ?? 0
  const numberOfGroups = Math.ceil(episodesCount / 100)
  const seasons = Array.from({ length: numberOfGroups }, (_, idx) => {
    const start = idx * 100 + 1
    const rawEnd = (idx + 1) * 100
    const end = rawEnd > episodesCount ? episodesCount : rawEnd
    return { number: idx, name: `${start}-${end}` } satisfies TeeviShowSeason
  })

  return {
    id,
    kind: isSeries ? "series" : "movie",
    title: show.title_eng,
    overview: overview,
    genres: show.genres?.map((g) => g.name) || [],
    duration: (show.episodes_length || 0) * 60,
    releaseDate: createDateFromSeason(Number(show.date), show.season),
    seasons: isSeries ? seasons : undefined,
    posterURL: posterURL,
    backdropURL: show.imageurl_cover,
    rating: rating,
    status: mapStatus(show.status),
  }
}

async function fetchEpisodes(
  id: string,
  season: number
): Promise<TeeviShowEpisode[]> {
  const numericId = Number(id.split("-")[0])
  const show = await fetchAUShow(id)
  const seasonEpisodes = await fetchAUShowEpisodes(
    numericId,
    season * 100 + 1,
    100
  )
  if (seasonEpisodes.length === 0) {
    return []
  }

  let titleByNumbers: Record<number, string> = {}
  let thumbnailByNumbers: Record<number, string | undefined> = {}
  if (show.mal_id) {
    const malEpisodes = await fetchJikanShowEpisodes(show.mal_id, season + 1)
    titleByNumbers = malEpisodes.reduce<Record<number, string>>((dict, ep) => {
      dict[ep.mal_id] = ep.title
      return dict
    }, {})
  }

  if (show.anilist_id) {
    const aniEpisodes = await fetchAnilistShowEpisodes(show.anilist_id)
    thumbnailByNumbers = aniEpisodes.reduce<Record<number, string | undefined>>(
      (dict, ep) => {
        dict[ep.number] = ep.thumbnail
        return dict
      },
      {}
    )
  }

  return seasonEpisodes.map((episode) => {
    const number = Number(episode.number)
    return {
      id: `${id}/${episode.id}`,
      number: number,
      title: titleByNumbers[number],
      thumbnailURL: thumbnailByNumbers[number],
    }
  })
}

async function fetchVideoAssets(id: string): Promise<TeeviVideoAsset[]> {
  const parts = id.split("/")
  let mediaId: number | undefined
  // Episode
  if (parts.length > 1) {
    mediaId = Number(parts[1].split("/")[0])
  }
  // Movie
  else {
    const showId = Number(parts[0].split("-")[0])

    const episodes = await fetchAUShowEpisodes(showId, 1, 1)
    if (episodes.length > 0) {
      mediaId = Number(episodes[0].id)
    }
  }

  if (!mediaId) {
    throw new Error("AU Media ID not found")
  }

  const videoURL = await fetchAUShowVideo(mediaId)
  const asset = await fetchVixcloudPlaylist(new URL(videoURL))
  return [asset]
}

export default {
  fetchShowsByQuery,
  fetchShow,
  fetchEpisodes,
  fetchVideoAssets,
} satisfies TeeviMetadataExtension & TeeviVideoExtension
