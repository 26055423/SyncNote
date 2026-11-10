import { useEffect, useState } from 'react';
import { api } from '../../api';
import { localTerminal, useLocalTerminal } from '../../localTerminal';
import type { MarketSymbol } from '../../SymbolPicker';
import type { Board } from '../workspace/types';

export function useSymbolCatalog(board: Board | null, local: ReturnType<typeof useLocalTerminal>) {
  const localConnected = local.phase === 'connected';
  const [storedSymbol, setStoredSymbol] = useState('XAUUSD');
  const [symbolOptions, setSymbolOptions] = useState<MarketSymbol[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolsError, setSymbolsError] = useState('');
  const [catalogSource, setCatalogSource] = useState<string | null>(null);
  const [catalogAvailable, setCatalogAvailable] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  useEffect(() => {
    if (localConnected) setStoredSymbol(local.symbol);
  }, [localConnected, local.symbol]);
  useEffect(() => {
    if (!board?.user.id) return;
    const controller = new AbortController();
    setSymbolsLoading(true); setSymbolsError('');
    void (async () => {
      try {
        if (localConnected) {
          if (!local.features.includes('symbols')) throw new Error('更新 SyncTrade EA 后即可在网页切换品种。');
          const symbols = await localTerminal.requestSymbols(controller.signal);
          if (!controller.signal.aborted) setSymbolOptions(symbols);
        } else {
          const result = await api<{ source: string | null; symbols: MarketSymbol[]; catalog_available?: boolean }>('/api/market/symbols', undefined, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setSymbolOptions(result.symbols); setCatalogSource(result.source);
          setCatalogAvailable(result.catalog_available === true);
          setStoredSymbol((current) => result.symbols.some((item) => item.symbol === current) ? current : result.symbols.find((item) => item.has_bars)?.symbol ?? result.symbols[0]?.symbol ?? current);
        }
      } catch (error) {
        if (!controller.signal.aborted) setSymbolsError(error instanceof Error ? error.message : '品种列表读取失败');
      } finally { if (!controller.signal.aborted) setSymbolsLoading(false); }
    })();
    return () => controller.abort();
  }, [board?.user.id, board?.market_source, localConnected, local.instance_id, local.epoch, local.features.includes('symbols'), catalogRevision]);
  return { storedSymbol, setStoredSymbol, symbolOptions, symbolsLoading, symbolsError, catalogSource, catalogAvailable, setCatalogRevision };
}
