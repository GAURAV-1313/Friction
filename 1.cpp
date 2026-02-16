#include <iostream>
#include <vector>
#include <algorithm>

// Binary Search (Iterative)
int binarySearchIterative(const std::vector<int>& arr, int target) {
    int left = 0;                     // O(1)
    int right = (int)arr.size() - 1;  // O(1)
    while (left <= right) {           // O(log n) iterations
        int mid = left + (right - left) / 2; // O(1)
        if (arr[mid] == target) {     // O(1)
            return mid;               // O(1)
        } else if (arr[mid] < target) { // O(1)
            left = mid + 1;           // O(1)
        } else {
            right = mid - 1;          // O(1)
        }
    }
    return -1;                        // O(1)
}

// Binary Search (Recursive)
int binarySearchRecursive(const std::vector<int>& arr, int left, int right, int target) {
    if (left > right) {               // O(1)
        return -1;                    // O(1)
    }
    int mid = left + (right - left) / 2; // O(1)
    if (arr[mid] == target) {         // O(1)
        return mid;                   // O(1)
    } else if (arr[mid] < target) {   // O(1)
        return binarySearchRecursive(arr, mid + 1, right, target); // O(log n)
    } else {
        return binarySearchRecursive(arr, left, mid - 1, target);  // O(log n)
    }
}

// Merge function for Merge Sort
void merge(std::vector<int>& arr, int left, int mid, int right) {
    int n1 = mid - left + 1;          // O(1)
    int n2 = right - mid;             // O(1)
    std::vector<int> L(n1), R(n2);    // O(n1 + n2)
    for (int i = 0; i < n1; ++i) {    // O(n1)
        L[i] = arr[left + i];         // O(1)
    }
    for (int j = 0; j < n2; ++j) {    // O(n2)
        R[j] = arr[mid + 1 + j];      // O(1)
    }
    int i = 0, j = 0, k = left;       // O(1)
    while (i < n1 && j < n2) {        // O(n1 + n2)
        if (L[i] <= R[j]) {           // O(1)
            arr[k] = L[i];            // O(1)
            ++i;                      // O(1)
        } else {
            arr[k] = R[j];            // O(1)
            ++j;                      // O(1)
        }
        ++k;                          // O(1)
    }
    while (i < n1) {                  // O(n1)
        arr[k] = L[i];                // O(1)
        ++i;                          // O(1)
        ++k;                          // O(1)
    }
    while (j < n2) {                  // O(n2)
        arr[k] = R[j];                // O(1)
        ++j;                          // O(1)
        ++k;                          // O(1)
    }
}

// Merge Sort
void mergeSort(std::vector<int>& arr, int left, int right) {
    if (left >= right) {              // O(1)
        return;                       // O(1)
    }
    int mid = left + (right - left) / 2; // O(1)
    mergeSort(arr, left, mid);        // O(log n)
    mergeSort(arr, mid + 1, right);   // O(log n)
    merge(arr, left, mid, right);     // O(n)
}

// Task 2: Election Winner in O(n log n)
// Sort votes, then count consecutive equal IDs to find max frequency.
int electionWinner(std::vector<int> votes) {
    std::sort(votes.begin(), votes.end()); // O(n log n)
    int bestCandidate = votes[0];          // O(1)
    int bestCount = 1;                     // O(1)
    int currentCandidate = votes[0];       // O(1)
    int currentCount = 1;                  // O(1)
    for (size_t i = 1; i < votes.size(); ++i) { // O(n)
        if (votes[i] == currentCandidate) {    // O(1)
            ++currentCount;                    // O(1)
        } else {
            if (currentCount > bestCount) {    // O(1)
                bestCount = currentCount;      // O(1)
                bestCandidate = currentCandidate; // O(1)
            }
            currentCandidate = votes[i];       // O(1)
            currentCount = 1;                  // O(1)
        }
    }
    if (currentCount > bestCount) {            // O(1)
        bestCount = currentCount;              // O(1)
        bestCandidate = currentCandidate;      // O(1)
    }
    return bestCandidate;                       // O(1)
}

int main() {
    // Sample usage (optional)
    std::vector<int> arr = {1, 3, 5, 7, 9, 11}; // O(1)
    int target = 7;                             // O(1)

    int idxIter = binarySearchIterative(arr, target); // O(log n)
    int idxRec = binarySearchRecursive(arr, 0, (int)arr.size() - 1, target); // O(log n)

    std::vector<int> toSort = {5, 2, 9, 1, 5, 6}; // O(1)
    mergeSort(toSort, 0, (int)toSort.size() - 1); // O(n log n)

    std::vector<int> votes = {3, 1, 2, 3, 3, 2, 1}; // O(1)
    int winner = electionWinner(votes);            // O(n log n)

    std::cout << "Iterative BS index: " << idxIter << "\n"; // O(1)
    std::cout << "Recursive BS index: " << idxRec << "\n"; // O(1)
    std::cout << "Winner: " << winner << "\n";             // O(1)
    return 0;                                             // O(1)
}
