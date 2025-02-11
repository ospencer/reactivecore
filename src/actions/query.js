import {
	SET_QUERY,
	SET_QUERY_OPTIONS,
	LOG_QUERY,
	LOG_COMBINED_QUERY,
	SET_LOADING,
	SET_TIMESTAMP,
	SET_HEADERS,
	SET_STREAMING,
	SET_QUERY_LISTENER,
	SET_SEARCH_ID,
	SET_ERROR,
	SET_PROMOTED_RESULTS,
} from '../constants';

import { setValue } from './value';
import { updateHits, updateAggs, pushToStreamHits } from './hits';
import { buildQuery, isEqual, getSearchState } from '../utils/helper';
import getFilterString from '../utils/analytics';
import { updateMapData } from './maps';
import fetchGraphQL from '../utils/graphQL';

export function setQuery(component, query) {
	return {
		type: SET_QUERY,
		component,
		query,
	};
}

export function updateQueryOptions(component, options) {
	return {
		type: SET_QUERY_OPTIONS,
		component,
		options,
	};
}

// gatekeeping for normal queries
export function logQuery(component, query) {
	return {
		type: LOG_QUERY,
		component,
		query,
	};
}

// gatekeeping for queries combined with map queries
export function logCombinedQuery(component, query) {
	return {
		type: LOG_COMBINED_QUERY,
		component,
		query,
	};
}

function setLoading(component, isLoading) {
	return {
		type: SET_LOADING,
		component,
		isLoading,
	};
}

function setError(component, error) {
	return {
		type: SET_ERROR,
		component,
		error,
	};
}

function setTimestamp(component, timestamp) {
	return {
		type: SET_TIMESTAMP,
		component,
		timestamp,
	};
}

export function setStreaming(component, status = false, ref = null) {
	return {
		type: SET_STREAMING,
		component,
		status,
		ref,
	};
}

export function setHeaders(headers) {
	return {
		type: SET_HEADERS,
		headers,
	};
}

export function setPromotedResults(results = []) {
	return {
		type: SET_PROMOTED_RESULTS,
		results,
	};
}

function setSearchId(searchId = null) {
	return {
		type: SET_SEARCH_ID,
		searchId,
	};
}

function msearch(
	query,
	orderOfQueries,
	appendToHits = false,
	isInternalComponent = false,
	appendToAggs = false,
) {
	return (dispatch, getState) => {
		const {
			appbaseRef,
			config,
			headers,
			queryListener,
			analytics,
			selectedValues,
		} = getState();

		let searchHeaders = {};

		// send search id or term in headers
		if (config.analytics && !isInternalComponent) {
			const { searchValue, searchId } = analytics;

			// if a filter string exists append that to the search headers
			const filterString = getFilterString(selectedValues);
			// if search id exists use that otherwise
			// it implies a new query in which case I send X-Search-Query
			if (searchId) {
				searchHeaders = Object.assign(
					{
						'X-Search-Id': searchId,
					},
					filterString && {
						'X-Search-Filters': filterString,
					},
				);
			} else if (searchValue) {
				searchHeaders = Object.assign(
					{
						'X-Search-Query': searchValue,
					},
					filterString && {
						'X-Search-Filters': filterString,
					},
				);
			}
			if (config.searchStateHeader) {
				const searchState = getSearchState(getState(), true);
				if (searchState && Object.keys(searchState).length) {
					searchHeaders['X-Search-State'] = JSON.stringify(searchState);
				}
			}
		}

		// set loading as active for the given component
		orderOfQueries.forEach((component) => {
			dispatch(setLoading(component, true));
		});

		const handleTransformResponse = (res, component) => {
			if (config.transformResponse && typeof config.transformResponse === 'function') {
				return config.transformResponse(res, component);
			}
			return new Promise(resolve => resolve(res));
		};

		const handleError = (error) => {
			console.error(error);
			orderOfQueries.forEach((component) => {
				if (queryListener[component] && queryListener[component].onError) {
					queryListener[component].onError(error);
				}
				dispatch(setError(component, error));
				dispatch(setLoading(component, false));
			});
		};

		const handleResponse = (res) => {
			const searchId = res._headers ? res._headers.get('X-Search-Id') : null;
			if (searchId) {
				// if search id was updated set it in store
				dispatch(setSearchId(searchId));
			}

			// handle promoted results
			orderOfQueries.forEach((component, index) => {
				handleTransformResponse(res.responses[index], component)
					.then((response) => {
						const { timestamp } = getState();
						if (
							timestamp[component] === undefined
							|| timestamp[component] < res._timestamp
						) {
							if (response.promoted) {
								dispatch(setPromotedResults(response.promoted));
							} else {
								dispatch(setPromotedResults());
							}
							if (response.hits) {
								dispatch(setTimestamp(component, res._timestamp));
								dispatch(updateHits(
									component,
									response.hits,
									response.took,
									appendToHits,
								));
								dispatch(setLoading(component, false));
							}

							if (response.aggregations) {
								dispatch(updateAggs(component, response.aggregations, appendToAggs));
							}
						}
					})
					.catch((err) => {
						handleError(err);
					});
			});
		};

		if (config.graphQLUrl) {
			fetchGraphQL(config.graphQLUrl, config.url, config.credentials, config.app, query)
				.then((res) => {
					handleResponse(res);
				})
				.catch((err) => {
					handleError(err);
				});
		} else {
			appbaseRef.setHeaders({ ...headers, ...searchHeaders });
			appbaseRef
				.msearch({
					type: config.type === '*' ? '' : config.type,
					body: query,
				})
				.then((res) => {
					handleResponse(res);
				})
				.catch((err) => {
					handleError(err);
				});
		}
	};
}

function executeQueryListener(listener, oldQuery, newQuery) {
	if (listener && listener.onQueryChange) {
		listener.onQueryChange(oldQuery, newQuery);
	}
}

export function executeQuery(componentId, executeWatchList = false, mustExecuteMapQuery = false) {
	return (dispatch, getState) => {
		const {
			queryLog,
			stream,
			appbaseRef,
			config,
			mapData,
			watchMan,
			dependencyTree,
			queryList,
			queryOptions,
			queryListener,
		} = getState();
		let orderOfQueries = [];
		let finalQuery = [];
		const matchAllQuery = { match_all: {} };

		let componentList = [componentId];

		if (executeWatchList) {
			const watchList = watchMan[componentId] || [];
			componentList = [...componentList, ...watchList];
		}

		componentList.forEach((component) => {
			// eslint-disable-next-line
			let { queryObj, options } = buildQuery(
				component,
				dependencyTree,
				queryList,
				queryOptions,
			);

			const validOptions = ['aggs', 'from', 'sort'];
			// check if query or options are valid - non-empty
			if (
				(queryObj && !!Object.keys(queryObj).length)
				|| (options && Object.keys(options).some(item => validOptions.includes(item)))
			) {
				// attach a match-all-query if empty
				if (!queryObj || (queryObj && !Object.keys(queryObj).length)) {
					queryObj = { ...matchAllQuery };
				}

				const currentQuery = {
					query: { ...queryObj },
					...options,
					...queryOptions[component],
				};

				const queryToLog = {
					query: { ...queryObj },
					...options,
					...queryOptions[component],
				};

				const oldQuery = queryLog[component];

				if (mustExecuteMapQuery || !isEqual(currentQuery, oldQuery)) {
					orderOfQueries = [...orderOfQueries, component];

					// log query before adding the map query,
					// since we don't do gatekeeping on the map query in the `queryLog`
					dispatch(logQuery(component, queryToLog));

					// add maps query here
					const isMapComponent = Object.keys(mapData).includes(component);

					if (isMapComponent && mapData[component].query) {
						// attach mapQuery to exisiting query via "must" type
						const existingQuery = currentQuery.query;
						currentQuery.query = {
							bool: {
								must: [existingQuery, mapData[component].query],
							},
						};

						if (!mapData[component].persistMapQuery) {
							// clear mapQuery if we don't want it to persist
							dispatch(updateMapData(componentId, null, false));
						}

						// skip the query execution if the combined query [component + map Query]
						// matches the logged combined query
						const { combinedLog } = getState();
						if (isEqual(combinedLog[component], currentQuery)) return;

						// log query after adding the map query,
						// to separately support gatekeeping for combined map queries
						dispatch(logCombinedQuery(component, currentQuery));
					}

					executeQueryListener(queryListener[component], oldQuery, currentQuery);

					// execute streaming query if applicable
					if (stream[component] && stream[component].status) {
						if (stream[component].ref) {
							stream[component].ref.stop();
						}

						const ref = appbaseRef.searchStream(
							{
								type: config.type === '*' ? '' : config.type,
								body: currentQuery,
							},
							(response) => {
								if (response._id) {
									dispatch(pushToStreamHits(component, response));
								}
							},
							(error) => {
								if (queryListener[component] && queryListener[component].onError) {
									queryListener[component].onError(error);
								}
								/**
								 * In android devices, sometime websocket throws error when there is no activity
								 * for a long time, console.error crashes the app, so changed it to console.warn
								 */
								console.warn(error);
								dispatch(setError(component, error));
								dispatch(setLoading(component, false));
							},
						);

						// update streaming ref
						dispatch(setStreaming(component, true, ref));
					}

					// push to combined query for msearch
					finalQuery = [
						...finalQuery,
						{
							preference: component,
						},
						currentQuery,
					];
				}
			}
		});

		if (finalQuery.length) {
			// in case of an internal component the analytics headers should not be included
			dispatch(msearch(finalQuery, orderOfQueries, false, componentId.endsWith('__internal')));
		}
	};
}

export function setQueryOptions(component, queryOptions, execute = true) {
	return (dispatch) => {
		dispatch(updateQueryOptions(component, queryOptions));

		if (execute) {
			dispatch(executeQuery(component, true));
		}
	};
}

export function updateQuery(
	{
		componentId,
		query,
		value,
		label = null,
		showFilter = true,
		URLParams = false,
		componentType = null,
		category = null,
	},
	execute = true,
) {
	return (dispatch) => {
		let queryToDispatch = query;
		if (query && query.query) {
			queryToDispatch = query.query;
		}
		// don't set filters for internal components
		if (!componentId.endsWith('__internal')) {
			dispatch(setValue(componentId, value, label, showFilter, URLParams, componentType, category));
		}
		dispatch(setQuery(componentId, queryToDispatch));
		if (execute) dispatch(executeQuery(componentId, true));
	};
}

export function loadMore(component, newOptions, appendToHits = true, appendToAggs = false) {
	// `appendToAggs` will be `true` in case of consecutive loading
	// of data-driven components via composite aggregations.

	// This approach will enable us to reset the component's query (aggs)
	// whenever there is a change in the component's subscribed source.
	return (dispatch, getState) => {
		const store = getState();
		let { queryObj, options } = buildQuery(
			component,
			store.dependencyTree,
			store.queryList,
			store.queryOptions,
		);

		const { queryLog } = store;

		if (!options) options = {};
		options = { ...options, ...newOptions };

		if (!queryObj || (queryObj && !Object.keys(queryObj).length)) {
			queryObj = { match_all: {} };
		}

		const currentQuery = {
			query: { ...queryObj },
			...options,
		};

		// query gatekeeping
		if (isEqual(queryLog[component], currentQuery)) return;

		dispatch(logQuery(component, currentQuery));

		const finalQuery = [
			{
				preference: component,
			},
			currentQuery,
		];

		dispatch(msearch(finalQuery, [component], appendToHits, false, appendToAggs));
	};
}

export function setQueryListener(component, onQueryChange, onError) {
	return {
		type: SET_QUERY_LISTENER,
		component,
		onQueryChange,
		onError,
	};
}
