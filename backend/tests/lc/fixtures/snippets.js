'use strict';
// Hand-written synthetic C++ snippets for the TLE -> AC fragile-flag fixtures.
// These are not student code. They exist only so `similarity()` has realistic line sets to compare.
//
// Pair A (longest-substring-without-repeating-characters): the AC differs from the TLE by one added
// early-exit line, so line-overlap similarity is 12/13 ~= 0.92 (> 0.8) -> quick_after_tle.
// Pair B (kth-largest-element-in-an-array): the AC is a different algorithm, overlap 5/12 ~= 0.42 -> no flag.

const TLE_SLIDING_WINDOW_NAIVE = `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        int best = 0;
        for (int i = 0; i < (int)s.size(); i++) {
            unordered_set<char> seen;
            int j = i;
            while (j < (int)s.size() && !seen.count(s[j])) seen.insert(s[j++]);
            best = max(best, j - i);
        }
        return best;
    }
};
`;

const AC_SLIDING_WINDOW_SIMILAR = `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        int best = 0;
        for (int i = 0; i < (int)s.size(); i++) {
            if (best >= (int)s.size() - i) break;
            unordered_set<char> seen;
            int j = i;
            while (j < (int)s.size() && !seen.count(s[j])) seen.insert(s[j++]);
            best = max(best, j - i);
        }
        return best;
    }
};
`;

const TLE_KTH_LARGEST_NAIVE = `class Solution {
public:
    int findKthLargest(vector<int>& nums, int k) {
        int ans = 0;
        for (int t = 0; t < k; t++) {
            int idx = 0;
            for (int i = 1; i < (int)nums.size(); i++) if (nums[i] > nums[idx]) idx = i;
            ans = nums[idx];
            nums.erase(nums.begin() + idx);
        }
        return ans;
    }
};
`;

const AC_KTH_LARGEST_DIFFERENT = `class Solution {
public:
    int findKthLargest(vector<int>& nums, int k) {
        int target = (int)nums.size() - k;
        nth_element(nums.begin(), nums.begin() + target, nums.end());
        return nums[target];
    }
};
`;

module.exports = { TLE_SLIDING_WINDOW_NAIVE, AC_SLIDING_WINDOW_SIMILAR, TLE_KTH_LARGEST_NAIVE, AC_KTH_LARGEST_DIFFERENT };
