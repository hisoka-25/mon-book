(function (root) {
  'use strict';

  var BUCKETS = [
    { id: 'living', label: 'Vivre, logement et études' },
    { id: 'family', label: 'Famille et obligations' },
    { id: 'unexpected', label: 'Imprévus' },
    { id: 'pleasure', label: 'Plaisirs et dépenses à surveiller' },
    { id: 'savings', label: 'Épargne' }
  ];

  var PROFILES = {
    base: {
      label: 'Modèle de base',
      note: 'Repère de départ : 50 % pour vivre, 30 % répartis entre famille, imprévus et plaisirs, 20 % pour l’épargne.',
      ratios: { living: 50, family: 10, unexpected: 10, pleasure: 10, savings: 20 }
    },
    studentWorkerHome: {
      label: 'Étudiant qui travaille et vit chez ses parents',
      note: 'Modèle indicatif avec une part d’épargne plus forte si le logement est principalement pris en charge.',
      ratios: { living: 40, family: 10, unexpected: 10, pleasure: 15, savings: 25 }
    },
    studentWorkerRent: {
      label: 'Étudiant qui travaille et paie logement et études',
      note: 'Modèle indicatif qui laisse davantage de place au logement et aux frais d’études.',
      ratios: { living: 65, family: 0, unexpected: 10, pleasure: 10, savings: 15 }
    },
    workerFamily: {
      label: 'Travailleur avec famille à charge',
      note: 'Modèle indicatif avec une enveloppe dédiée aux obligations familiales.',
      ratios: { living: 50, family: 20, unexpected: 10, pleasure: 5, savings: 15 }
    },
    workerSingle: {
      label: 'Travailleur célibataire sans charge familiale',
      note: 'Modèle indicatif sans enveloppe familiale obligatoire.',
      ratios: { living: 50, family: 0, unexpected: 10, pleasure: 20, savings: 20 }
    },
    studentPocketCoveredSave: {
      label: 'Étudiant avec argent de poche, besoins principaux pris en charge, veut épargner',
      note: 'À choisir seulement si le logement et la plupart des besoins essentiels sont pris en charge.',
      ratios: { living: 35, family: 0, unexpected: 10, pleasure: 25, savings: 30 }
    },
    studentPocketOwnCostsSave: {
      label: 'Étudiant avec argent de poche, paie ses besoins, veut épargner',
      note: 'Modèle indicatif si l’argent de poche doit couvrir une grande partie des dépenses courantes.',
      ratios: { living: 65, family: 0, unexpected: 10, pleasure: 15, savings: 10 }
    },
    studentPocketNoSave: {
      label: 'Étudiant avec argent de poche, sans objectif d’épargne pour le moment',
      note: 'L’objectif d’épargne est facultatif. Les montants restent ajustables selon les dépenses réelles.',
      ratios: { living: 70, family: 0, unexpected: 10, pleasure: 20, savings: 0 }
    }
  };

  var CATEGORIES = [
    { id: 'housing', label: 'Logement / loyer', bucket: 'living', nature: 'fixed', priority: 'useful' },
    { id: 'food', label: 'Alimentation', bucket: 'living', nature: 'variable', priority: 'useful' },
    { id: 'transport', label: 'Transport', bucket: 'living', nature: 'variable', priority: 'useful' },
    { id: 'studies', label: 'Études / frais scolaires', bucket: 'living', nature: 'fixed', priority: 'useful' },
    { id: 'work', label: 'Travail / outils nécessaires', bucket: 'living', nature: 'variable', priority: 'useful' },
    { id: 'health', label: 'Santé', bucket: 'living', nature: 'variable', priority: 'useful' },
    { id: 'phone', label: 'Téléphone / Internet', bucket: 'living', nature: 'fixed', priority: 'useful' },
    { id: 'bills', label: 'Factures / services essentiels', bucket: 'living', nature: 'fixed', priority: 'useful' },
    { id: 'family', label: 'Aide à la famille', bucket: 'family', nature: 'variable', priority: 'useful' },
    { id: 'dependants', label: 'Enfants / personnes à charge', bucket: 'family', nature: 'fixed', priority: 'useful' },
    { id: 'unexpected', label: 'Dépense imprévue', bucket: 'unexpected', nature: 'variable', priority: 'useful' },
    { id: 'leisure', label: 'Loisirs / sorties', bucket: 'pleasure', nature: 'variable', priority: 'watch' },
    { id: 'shopping', label: 'Achats / extras', bucket: 'pleasure', nature: 'variable', priority: 'watch' },
    { id: 'optionalSubscription', label: 'Abonnement / service facultatif', bucket: 'pleasure', nature: 'fixed', priority: 'watch' },
    { id: 'otherUseful', label: 'Autre dépense utile', bucket: 'living', nature: 'variable', priority: 'useful' },
    { id: 'otherFamily', label: 'Autre dépense familiale', bucket: 'family', nature: 'variable', priority: 'useful' },
    { id: 'otherWatch', label: 'Autre dépense à surveiller', bucket: 'pleasure', nature: 'variable', priority: 'watch' }
  ];

  var MAX_AMOUNT = 1000000000;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function toAmount(value) {
    if (value === '' || value === null || value === undefined) return 0;
    var number = Number(value);
    if (!Number.isFinite(number)) return 0;
    number = Math.round(number);
    if (number < 0) return 0;
    if (number > MAX_AMOUNT) return MAX_AMOUNT;
    return number;
  }

  function isValidRatios(ratios) {
    if (!isObject(ratios)) return false;
    var total = 0;
    for (var i = 0; i < BUCKETS.length; i += 1) {
      var value = ratios[BUCKETS[i].id];
      if (!Number.isInteger(value) || value < 0 || value > 100) return false;
      total += value;
    }
    return total === 100;
  }

  function copyRatios(ratios) {
    var copy = {};
    BUCKETS.forEach(function (bucket) { copy[bucket.id] = Number(ratios[bucket.id]); });
    return copy;
  }

  function getProfile(profileId) {
    return PROFILES[profileId] || PROFILES.base;
  }

  function getCategory(categoryId) {
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      if (CATEGORIES[i].id === categoryId) return CATEGORIES[i];
    }
    return CATEGORIES.filter(function (category) { return category.id === 'otherUseful'; })[0];
  }

  function normalizeExpense(item) {
    if (!isObject(item)) return null;
    var category = getCategory(item.category);
    var amount = toAmount(item.amount);
    var label = String(item.label || '').trim().slice(0, 80);
    if (!label || amount < 1) return null;
    var date = /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) ? String(item.date) : '';
    return {
      id: String(item.id || '').slice(0, 80),
      label: label,
      amount: amount,
      category: category.id,
      bucket: category.bucket,
      nature: item.nature === 'fixed' ? 'fixed' : 'variable',
      priority: item.priority === 'watch' ? 'watch' : 'useful',
      date: date
    };
  }

  function normalizePeriod(period) {
    var source = isObject(period) ? period : {};
    var profileId = Object.prototype.hasOwnProperty.call(PROFILES, source.profile) ? source.profile : 'base';
    var ratios = isValidRatios(source.ratios) ? copyRatios(source.ratios) : copyRatios(PROFILES[profileId].ratios);
    var expenses = Array.isArray(source.expenses)
      ? source.expenses.slice(-1000).map(normalizeExpense).filter(Boolean)
      : [];
    return {
      profile: profileId,
      available: toAmount(source.available),
      ratios: ratios,
      saved: toAmount(source.saved),
      expenses: expenses
    };
  }

  function allocateTargets(total, ratios) {
    var amount = toAmount(total);
    var safeRatios = isValidRatios(ratios) ? ratios : PROFILES.base.ratios;
    var rows = BUCKETS.map(function (bucket, index) {
      var exact = amount * safeRatios[bucket.id] / 100;
      var floor = Math.floor(exact);
      return { id: bucket.id, index: index, value: floor, fraction: exact - floor };
    });
    var allocated = rows.reduce(function (sum, row) { return sum + row.value; }, 0);
    var remainder = amount - allocated;
    rows.slice().sort(function (a, b) {
      return b.fraction - a.fraction || a.index - b.index;
    }).slice(0, remainder).forEach(function (row) {
      rows.filter(function (candidate) { return candidate.id === row.id; })[0].value += 1;
    });
    var result = {};
    rows.forEach(function (row) { result[row.id] = row.value; });
    return result;
  }

  function calculate(period) {
    var normalized = normalizePeriod(period);
    var targets = allocateTargets(normalized.available, normalized.ratios);
    var spentByBucket = {};
    var spentByCategory = {};
    var actualByBucket = {};
    var remainingByBucket = {};
    BUCKETS.forEach(function (bucket) { spentByBucket[bucket.id] = 0; });
    CATEGORIES.forEach(function (category) { spentByCategory[category.id] = 0; });

    var totals = { fixed: 0, variable: 0, useful: 0, watch: 0 };
    normalized.expenses.forEach(function (expense) {
      spentByBucket[expense.bucket] = (spentByBucket[expense.bucket] || 0) + expense.amount;
      spentByCategory[expense.category] = (spentByCategory[expense.category] || 0) + expense.amount;
      totals[expense.nature] += expense.amount;
      totals[expense.priority] += expense.amount;
    });

    var totalExpenses = normalized.expenses.reduce(function (sum, expense) { return sum + expense.amount; }, 0);
    BUCKETS.forEach(function (bucket) {
      actualByBucket[bucket.id] = bucket.id === 'savings' ? normalized.saved : spentByBucket[bucket.id];
      remainingByBucket[bucket.id] = targets[bucket.id] - actualByBucket[bucket.id];
    });

    return {
      period: normalized,
      ratios: normalized.ratios,
      targets: targets,
      spentByBucket: spentByBucket,
      spentByCategory: spentByCategory,
      actualByBucket: actualByBucket,
      remainingByBucket: remainingByBucket,
      totalExpenses: totalExpenses,
      saved: normalized.saved,
      remainingOverall: normalized.available - totalExpenses - normalized.saved,
      totals: totals
    };
  }

  var api = {
    BUCKETS: BUCKETS,
    PROFILES: PROFILES,
    CATEGORIES: CATEGORIES,
    MAX_AMOUNT: MAX_AMOUNT,
    toAmount: toAmount,
    isValidRatios: isValidRatios,
    copyRatios: copyRatios,
    getProfile: getProfile,
    getCategory: getCategory,
    normalizePeriod: normalizePeriod,
    allocateTargets: allocateTargets,
    calculate: calculate
  };

  root.MonBookBudgetModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
