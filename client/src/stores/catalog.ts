import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import * as api from '../api'
import type { CatalogFile, CatalogFixture } from '@preflight/shared'
import { GENERIC_CATALOG_ENTRY, GENERIC_MOVING_HEAD, profileFromCatalog, type FixtureProfile } from '../domain/profiles'

/** The fixture catalog (from the Open Fixture Library), loaded once from the server. */
export const useCatalog = defineStore('catalog', () => {
  const items = ref<CatalogFixture[]>([])
  /** where the catalog comes from; null until it has loaded */
  const source = ref<CatalogFile['source'] | null>(null)
  const importedAt = ref('')
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const error = ref<string | null>(null)

  /** What each catalog fixture can do, by its id (see domain/profiles.ts). */
  const profiles = shallowRef(new Map<string, FixtureProfile>())

  /**
   * The profile of a fixture. One that is not in the catalog (yet) is the generic moving head; whatever reads this updates
   * when the catalog arrives.
   */
  function profileFor(id: string): FixtureProfile {
    return profiles.value.get(id) ?? GENERIC_MOVING_HEAD
  }

  /** Every fixture the picker can offer: the generic one first, then the catalog. */
  const all = computed(() => [GENERIC_CATALOG_ENTRY, ...items.value])

  async function load() {
    if (status.value === 'loading' || status.value === 'ready') return
    status.value = 'loading'
    try {
      const file = await api.fetchCatalog()
      items.value = file.fixtures
      source.value = file.source
      importedAt.value = file.importedAt
      profiles.value = new Map(file.fixtures.map((item) => [item.id, profileFromCatalog(item)]))
      status.value = 'ready'
      error.value = null
    } catch (e) {
      error.value = (e as Error).message
      status.value = 'error'
    }
  }

  return { items, all, source, importedAt, status, error, profiles, profileFor, load }
})
