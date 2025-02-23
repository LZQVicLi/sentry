import {Fragment, useCallback, useEffect, useMemo, useState} from 'react';
import {Link} from 'react-router';
import styled from '@emotion/styled';
import debounce from 'lodash/debounce';

import CompactSelect from 'sentry/components/compactSelect';
import GridEditable, {
  COL_WIDTH_UNDEFINED,
  GridColumnOrder,
} from 'sentry/components/gridEditable';
import Pagination from 'sentry/components/pagination';
import SearchBar from 'sentry/components/searchBar';
import {t} from 'sentry/locale';
import space from 'sentry/styles/space';
import {Container, NumberContainer} from 'sentry/utils/discover/styles';
import {generateProfileFlamechartRouteWithQuery} from 'sentry/utils/profiling/routes';
import {renderTableHead} from 'sentry/utils/profiling/tableRenderer';
import {makeFormatter} from 'sentry/utils/profiling/units/units';
import {useEffectAfterFirstRender} from 'sentry/utils/useEffectAfterFirstRender';
import {useLocation} from 'sentry/utils/useLocation';
import {useParams} from 'sentry/utils/useParams';

import {useProfileGroup} from '../../profileGroupProvider';
import {useColumnFilters} from '../hooks/useColumnFilters';
import {useFuseSearch} from '../hooks/useFuseSearch';
import {usePageLinks} from '../hooks/usePageLinks';
import {useQuerystringState} from '../hooks/useQuerystringState';
import {useSortableColumns} from '../hooks/useSortableColumn';
import {aggregate, AggregateColumnConfig, collectProfileFrames} from '../utils';

const RESULTS_PER_PAGE = 50;

export function ProfileDetailsTable() {
  const location = useLocation();
  const [state] = useProfileGroup();
  const [groupByViewKey, setGroupByView] = useQuerystringState({
    key: 'detailView',
    initialState: 'occurrence',
  });

  const [searchQuery, setSearchQuery] = useQuerystringState({
    key: 'query',
    initialState: '',
  });

  const [paginationCursor, setPaginationCursor] = useQuerystringState({
    key: 'cursor',
    initialState: '',
  });

  const groupByView = GROUP_BY_OPTIONS[groupByViewKey] ?? GROUP_BY_OPTIONS.occurrence;

  const cursor = parseInt(paginationCursor, 10) || 0;

  const allData: TableDataRow[] = useMemo(() => {
    const data =
      state.type === 'resolved' ? state.data.profiles.flatMap(collectProfileFrames) : [];

    return groupByView.transform(data);
  }, [state, groupByView]);

  const {search} = useFuseSearch(allData, {
    keys: groupByView.search.key,
    threshold: 0.3,
  });

  const debouncedSearch = useMemo(
    () => debounce(searchString => setFilteredDataBySearch(search(searchString)), 500),
    [search]
  );

  const [filteredDataBySearch, setFilteredDataBySearch] = useState<TableDataRow[]>(() => {
    return search(searchQuery);
  });

  const [typeFilter, setTypeFilter] = useQuerystringState({
    key: 'type',
  });

  const [imageFilter, setImageFilter] = useQuerystringState({
    key: 'image',
  });

  const {filters, columnFilters, filterPredicate} = useColumnFilters(allData, {
    columns: ['type', 'image'],
    initialState: {
      type: typeFilter,
      image: imageFilter,
    },
  });

  useEffect(() => {
    setTypeFilter(filters.type);
    setImageFilter(filters.image);
  }, [filters, setTypeFilter, setImageFilter]);

  const {currentSort, generateSortLink, sortCompareFn} = useSortableColumns({
    ...groupByView.sort,
    querystringKey: 'functionsSort',
  });

  const handleSearch = useCallback(
    searchString => {
      setSearchQuery(searchString);
      setPaginationCursor(undefined);
      debouncedSearch(searchString);
    },
    [setPaginationCursor, setSearchQuery, debouncedSearch]
  );

  useEffectAfterFirstRender(() => {
    setFilteredDataBySearch(search(searchQuery));
    // purposely omitted `searchQuery` as we only want this to run once.
    // future search filters are called by handleSearch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allData, search]);

  const filteredData = useMemo(
    () => filteredDataBySearch.filter(filterPredicate),
    [filterPredicate, filteredDataBySearch]
  );

  const sortedData = useMemo(
    () => filteredData.sort(sortCompareFn),
    [filteredData, sortCompareFn]
  );

  const pageLinks = usePageLinks(sortedData, cursor);

  const data = sortedData.slice(cursor, cursor + RESULTS_PER_PAGE);

  return (
    <Fragment>
      <ActionBar>
        <CompactSelect
          options={Object.values(GROUP_BY_OPTIONS).map(view => view.option)}
          value={groupByView.option.value}
          triggerProps={{
            prefix: t('View'),
          }}
          placement="bottom right"
          onChange={option => {
            setSearchQuery('');
            setPaginationCursor(undefined);
            setGroupByView(option.value);
          }}
        />
        <SearchBar
          defaultQuery=""
          query={searchQuery}
          placeholder={groupByView.search.placeholder}
          onChange={handleSearch}
        />

        <CompactSelect
          options={columnFilters.type.values.map(value => ({value, label: value}))}
          value={filters.type}
          triggerLabel={
            !filters.type ||
            (Array.isArray(filters.type) &&
              filters.type.length === columnFilters.type.values.length)
              ? t('All')
              : undefined
          }
          triggerProps={{
            prefix: t('Type'),
          }}
          multiple
          onChange={columnFilters.type.onChange}
          placement="bottom right"
        />
        <CompactSelect
          options={columnFilters.image.values.map(value => ({value, label: value}))}
          value={filters.image}
          triggerLabel={
            !filters.image ||
            (Array.isArray(filters.image) &&
              filters.image.length === columnFilters.image.values.length)
              ? t('All')
              : undefined
          }
          triggerProps={{
            prefix: t('Package'),
          }}
          multiple
          onChange={columnFilters.image.onChange}
          placement="bottom right"
          isSearchable
        />
      </ActionBar>

      <GridEditable
        isLoading={state.type === 'loading'}
        error={state.type === 'errored'}
        data={data}
        columnOrder={groupByView.columns.map(key => COLUMNS[key])}
        columnSortBy={[currentSort]}
        scrollable
        stickyHeader
        height="75vh"
        grid={{
          renderHeadCell: renderTableHead({
            rightAlignedColumns: new Set(groupByView.rightAlignedColumns),
            sortableColumns: new Set(groupByView.rightAlignedColumns),
            currentSort,
            generateSortLink,
          }),
          renderBodyCell: renderFunctionCell,
        }}
        location={location}
      />

      <Pagination pageLinks={pageLinks} />
    </Fragment>
  );
}

const ActionBar = styled('div')`
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: ${space(2)};
  margin-bottom: ${space(2)};
`;

function renderFunctionCell(
  column: TableColumn,
  dataRow: TableDataRow,
  rowIndex: number,
  columnIndex: number
) {
  return (
    <ProfilingFunctionsTableCell
      column={column}
      dataRow={dataRow}
      rowIndex={rowIndex}
      columnIndex={columnIndex}
    />
  );
}

interface ProfilingFunctionsTableCellProps {
  column: TableColumn;
  columnIndex: number;
  dataRow: TableDataRow;
  rowIndex: number;
}

const formatter = makeFormatter('nanoseconds');
function ProfilingFunctionsTableCell({
  column,
  dataRow,
}: ProfilingFunctionsTableCellProps) {
  const value = dataRow[column.key];
  const {orgId, projectId, eventId} = useParams();

  switch (column.key) {
    case 'p75':
    case 'p95':
    case 'self weight':
    case 'total weight':
      return <NumberContainer>{formatter(value as number)}</NumberContainer>;
    case 'count':
      return <NumberContainer>{value}</NumberContainer>;
    case 'image':
      return <Container>{value ?? t('Unknown')}</Container>;
    case 'thread': {
      return (
        <Container>
          <Link
            to={generateProfileFlamechartRouteWithQuery({
              orgSlug: orgId,
              projectSlug: projectId,
              profileId: eventId,
              query: {tid: dataRow.thread as string},
            })}
          >
            {value}
          </Link>
        </Container>
      );
    }
    default:
      return <Container>{value}</Container>;
  }
}

const tableColumnKey = [
  'symbol',
  'image',
  'file',
  'thread',
  'type',
  'self weight',
  'total weight',
  'p75',
  'p95',
  'count',
] as const;

type TableColumnKey = typeof tableColumnKey[number];

type TableDataRow = Partial<Record<TableColumnKey, string | number>>;

type TableColumn = GridColumnOrder<TableColumnKey>;

// TODO: looks like these column names change depending on the platform?
const COLUMNS: Record<TableColumnKey, TableColumn> = {
  symbol: {
    key: 'symbol',
    name: t('Symbol'),
    width: COL_WIDTH_UNDEFINED,
  },
  image: {
    key: 'image',
    name: t('Package'),
    width: COL_WIDTH_UNDEFINED,
  },
  file: {
    key: 'file',
    name: t('File'),
    width: COL_WIDTH_UNDEFINED,
  },
  thread: {
    key: 'thread',
    name: t('Thread'),
    width: COL_WIDTH_UNDEFINED,
  },
  type: {
    key: 'type',
    name: t('Type'),
    width: COL_WIDTH_UNDEFINED,
  },
  'self weight': {
    key: 'self weight',
    name: t('Self Weight'),
    width: COL_WIDTH_UNDEFINED,
  },
  'total weight': {
    key: 'total weight',
    name: t('Total Weight'),
    width: COL_WIDTH_UNDEFINED,
  },
  p75: {
    key: 'p75',
    name: t('P75(Self)'),
    width: COL_WIDTH_UNDEFINED,
  },
  p95: {
    key: 'p95',
    name: t('P95(Self)'),
    width: COL_WIDTH_UNDEFINED,
  },
  count: {
    key: 'count',
    name: t('Count'),
    width: COL_WIDTH_UNDEFINED,
  },
};

const quantile = (arr: readonly number[], q: number) => {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const position = q * (sorted.length - 1);
  const int = Math.floor(position);
  const frac = position % 1;
  if (position === int) {
    return sorted[position];
  }

  return sorted[int] * (1 - frac) + sorted[int + 1] * frac;
};

const p75AggregateColumn: AggregateColumnConfig<TableColumnKey> = {
  key: 'p75',
  compute: rows => quantile(rows.map(v => v['self weight']) as number[], 0.75),
};

const p95AggregateColumn: AggregateColumnConfig<TableColumnKey> = {
  key: 'p95',
  compute: rows => quantile(rows.map(v => v['self weight']) as number[], 0.95),
};

const countAggregateColumn: AggregateColumnConfig<TableColumnKey> = {
  key: 'count',
  compute: rows => rows.length,
};

interface GroupByOptions<T> {
  columns: T[];
  option: {
    label: string;
    value: string;
  };
  rightAlignedColumns: T[];
  search: {
    key: T[];
    placeholder: string;
  };
  sort: {
    defaultSort: {
      key: T;
      order: 'asc' | 'desc';
    };
    sortableColumns: T[];
  };
  transform: (
    data: Partial<Record<Extract<T, string>, string | number | undefined>>[]
  ) => Record<Extract<T, string>, string | number | undefined>[];
}

const GROUP_BY_OPTIONS: Record<string, GroupByOptions<TableColumnKey>> = {
  occurrence: {
    option: {
      label: t('Slowest Functions'),
      value: 'occurrence',
    },
    columns: ['symbol', 'image', 'file', 'thread', 'type', 'self weight', 'total weight'],
    transform: (data: any[]) => data.slice(0, 500),
    search: {
      key: ['symbol'],
      placeholder: t('Search for frames'),
    },
    sort: {
      sortableColumns: ['self weight', 'total weight'],
      defaultSort: {
        key: 'self weight',
        order: 'desc',
      },
    },
    rightAlignedColumns: ['self weight', 'total weight'],
  },
  symbol: {
    option: {
      label: t('Group by Symbol'),
      value: 'symbol',
    },
    columns: ['symbol', 'type', 'image', 'p75', 'p95', 'count'],
    search: {
      key: ['symbol'],
      placeholder: t('Search for frames'),
    },
    transform: data =>
      aggregate(
        data,
        ['symbol', 'type', 'image'],
        [p75AggregateColumn, p95AggregateColumn, countAggregateColumn]
      ),
    sort: {
      sortableColumns: ['p75', 'p95', 'count'],
      defaultSort: {
        key: 'p75',
        order: 'desc',
      },
    },
    rightAlignedColumns: ['p75', 'p95', 'count'],
  },
  package: {
    option: {
      label: t('Group by Package'),
      value: 'package',
    },
    columns: ['image', 'type', 'p75', 'p95', 'count'],
    search: {
      key: ['image'],
      placeholder: t('Search for packages'),
    },
    transform: data =>
      aggregate(
        data,
        ['type', 'image'],
        [p75AggregateColumn, p95AggregateColumn, countAggregateColumn]
      ),
    sort: {
      sortableColumns: ['p75', 'p95', 'count'],
      defaultSort: {
        key: 'p75',
        order: 'desc',
      },
    },
    rightAlignedColumns: ['p75', 'p95', 'count'],
  },
  file: {
    option: {
      label: t('Group by File'),
      value: 'file',
    },
    columns: ['file', 'type', 'image', 'p75', 'p95', 'count'],
    search: {
      key: ['file'],
      placeholder: t('Search for files'),
    },
    transform: data =>
      aggregate(
        data,
        ['type', 'image', 'file'],
        [p75AggregateColumn, p95AggregateColumn, countAggregateColumn]
      ),
    sort: {
      sortableColumns: ['p75', 'p95', 'count'],
      defaultSort: {
        key: 'p75',
        order: 'desc',
      },
    },
    rightAlignedColumns: ['p75', 'p95', 'count'],
  },
};
