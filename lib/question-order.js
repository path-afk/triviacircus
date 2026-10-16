'use strict';

/**
 * Return a randomized question order with category streaks kept as short as
 * the category counts permit. The input array and its question objects are
 * never changed.
 *
 * @param {Array<object>} questions
 * @param {() => number} random A Math.random-compatible function.
 * @returns {Array<object>}
 */
function categoryBalancedShuffle(questions, random = Math.random) {
  if (!Array.isArray(questions)) {
    throw new TypeError('questions must be an array');
  }
  if (typeof random !== 'function') {
    throw new TypeError('random must be a function');
  }
  if (questions.length < 2) return questions.slice();

  const randomUnit = () => {
    const value = Number(random());
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('random must return a number in [0, 1)');
    }
    return value;
  };

  const shuffle = values => {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(randomUnit() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  const byCategory = new Map();
  for (const question of questions) {
    const category = question.category;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(question);
  }

  // Shuffle both levels independently: item order inside a category and the
  // category iteration order used by weighted random selection.
  let groups = [...byCategory.entries()].map(([category, items]) => ({
    category,
    items: shuffle(items),
  }));
  groups = shuffle(groups);

  const total = questions.length;
  let runLimit = 1;
  for (const group of groups) {
    const count = group.items.length;
    runLimit = Math.max(runLimit, Math.ceil(count / (total - count + 1)));
  }

  const result = [];
  let lastGroup = null;
  let currentRun = 0;
  let remainingTotal = total;

  // Check whether choosing a group still permits every remaining category to
  // fit under the mathematically minimal run limit. For the category just
  // chosen, the partially filled trailing run reduces its first available gap.
  const remainsCompletable = candidate => {
    const nextRun = candidate === lastGroup ? currentRun + 1 : 1;
    if (nextRun > runLimit) return false;

    const afterTotal = remainingTotal - 1;
    for (const group of groups) {
      const count = group.items.length - (group === candidate ? 1 : 0);
      if (count === 0) continue;
      const otherCount = afterTotal - count;
      const capacity = runLimit * (otherCount + 1)
        - (group === candidate ? nextRun : 0);
      if (count > capacity) return false;
    }
    return true;
  };

  const weightedChoice = candidates => {
    const weight = candidates.reduce((sum, group) => sum + group.items.length, 0);
    let target = randomUnit() * weight;
    for (const group of candidates) {
      target -= group.items.length;
      if (target < 0) return group;
    }
    return candidates[candidates.length - 1];
  };

  while (remainingTotal > 0) {
    const feasible = groups.filter(group =>
      group.items.length > 0 && remainsCompletable(group));
    if (feasible.length === 0) {
      throw new Error('unable to construct a category-balanced order');
    }

    // Avoid adjacency whenever doing so does not sacrifice the optimal global
    // run limit. A repeat is selected only when it is needed to prevent a
    // longer, avoidable streak later in a skewed data set.
    const alternatives = feasible.filter(group => group !== lastGroup);
    const chosen = weightedChoice(alternatives.length > 0 ? alternatives : feasible);
    const question = chosen.items.pop();

    result.push(question);
    currentRun = chosen === lastGroup ? currentRun + 1 : 1;
    lastGroup = chosen;
    remainingTotal -= 1;
  }

  return result;
}

module.exports = { categoryBalancedShuffle };
